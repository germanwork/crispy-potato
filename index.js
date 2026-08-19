const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');

// API key gratuita de TMDB (mismo proyecto que usás en el addon de LaMovie,
// se puede reusar la misma key sin problema). Se usa para conseguir el ID de
// TMDB de forma confiable por IMDb ID, ya que Poseidon usa ese mismo ID
// numérico en sus URLs (/serie/94997/..., /pelicula/1368337/...).
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Convierte un título a slug tipo URL (ej: "La muerte de Robin Hood" ->
// "la-muerte-de-robin-hood"), transliterando acentos/ñ en vez de perderlos.
function slugify(text) {
    if (!text) return '';
    let s = text.toLowerCase();
    const accents = { 'á':'a','é':'e','í':'i','ó':'o','ú':'u','ü':'u','à':'a','è':'e','ì':'i','ò':'o','ù':'u','ñ':'n','ç':'c' };
    for (const [accented, plain] of Object.entries(accents)) {
        s = s.split(accented).join(plain);
    }
    s = s.replace(/[^a-z0-9\s-]/g, '');
    s = s.replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
    return s;
}

async function getTmdbId(imdbId, type) {
    if (!TMDB_API_KEY) return { id: null, esTitle: null };
    try {
        const resp = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
            params: { api_key: TMDB_API_KEY, external_source: 'imdb_id', language: 'es-MX' },
            timeout: 6000
        });
        const key = type === 'series' ? 'tv_results' : 'movie_results';
        const results = resp.data && resp.data[key];
        if (results && results.length > 0) {
            const item = results[0];
            const esTitle = item.title || item.name || null;
            return { id: String(item.id), esTitle };
        }
        return { id: null, esTitle: null };
    } catch (e) {
        console.log('Error consultando TMDB find:', e.message);
        return { id: null, esTitle: null };
    }
}
const puppeteer = require('puppeteer');
const { URL } = require('url');

// URL pública donde queda expuesto este addon (ver más abajo). Se usa para
// construir las URLs del proxy de HLS que le entregamos al reproductor.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 7000}`).replace(/\/+$/, '');

const PS_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

// ==========================================
// UTILIDADES Y FUNCIONES PURAS
// ==========================================
function unpackJsVh(p, a, c, k) {
    while (c--) {
        if (k[c]) p = p.replace(new RegExp('\\b' + c.toString(a) + '\\b', 'g'), k[c]);
    }
    return p;
}

function makeAbsoluteVh(url, base) {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.indexOf('/') === 0) {
        // Path absoluto desde la raíz del dominio (empieza con "/"): hay que
        // resolverlo contra el ORIGEN (protocolo+host), no contra el directorio
        // completo de "base" — si no, el path del directorio queda duplicado
        // (ej: ".../carpeta/carpeta/archivo.ts" en vez de ".../carpeta/archivo.ts").
        try {
            return new URL(base).origin + url;
        } catch (e) {
            return base + url;
        }
    }
    return base + '/' + url;
}

function parseJsObjVh(str) {
    try {
        var clean = str
            .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
            .replace(/:\s*'([^']*)'/g, ':"$1"')
            .replace(/,\s*\}/g, '}');
        return JSON.parse(clean);
    } catch(e) {}
    return null;
}

function extractM3u8FromObjVh(obj, base) {
    if (!obj) return null;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
        var v = obj[keys[i]];
        if (v && typeof v === 'string' && v.indexOf('master.m3u8') !== -1) return makeAbsoluteVh(v, base);
    }
    for (var j = 0; j < keys.length; j++) {
        var v2 = obj[keys[j]];
        if (v2 && typeof v2 === 'string' && v2.indexOf('.m3u8') !== -1) return makeAbsoluteVh(v2, base);
    }
    for (var k = 0; k < keys.length; k++) {
        var v3 = obj[keys[k]];
        if (v3 && typeof v3 === 'string' && v3.indexOf('/hls/') !== -1) return makeAbsoluteVh(v3, base);
    }
    return null;
}

function extractHlsFromCallistanise(code, base) {
    var sourceRefM = code.match(/(?:sources?|file)\s*:\s*(?:\[?\s*\{[^}]*(?:file|src)\s*:\s*)?([a-zA-Z_$][a-zA-Z0-9_$]{0,4})\s*\.\s*([a-zA-Z0-9_]+)\s*\|\|\s*\1\s*\.\s*([a-zA-Z0-9_]+)(?:\s*\|\|\s*\1\s*\.\s*([a-zA-Z0-9_]+))?/i);
    if (sourceRefM) {
        var varName = sourceRefM[1];
        var keys = [sourceRefM[2], sourceRefM[3]];
        if (sourceRefM[4]) keys.push(sourceRefM[4]);
        var varRe = new RegExp('var\\s+' + varName.replace('$', '\\$') + '\\s*=\\s*(\\{[\\s\\S]{1,800}?\\})', 'i');
        var vm = code.match(varRe);
        if (vm) {
            var vo = parseJsObjVh(vm[1]);
            if (vo) {
                for (var ki = 0; ki < keys.length; ki++) {
                    var kv = vo[keys[ki]];
                    if (kv && kv.indexOf('.m3u8') !== -1) return makeAbsoluteVh(kv, base);
                }
                var fb = extractM3u8FromObjVh(vo, base);
                if (fb) return fb;
            }
        }
    }

    var anyVarM = code.match(/var\s+([a-zA-Z_$][a-zA-Z0-9_$]{0,4})\s*=\s*(\{[^{}]{10,800}\})/g);
    if (anyVarM) {
        for (var vi = 0; vi < anyVarM.length; vi++) {
            var vm2 = anyVarM[vi].match(/var\s+([a-zA-Z_$][a-zA-Z0-9_$]{0,4})\s*=\s*(\{[^{}]{10,800}\})/);
            if (!vm2) continue;
            if (vm2[2].indexOf('m3u8') === -1 && vm2[2].indexOf('/hls/') === -1) continue;
            var vo2 = parseJsObjVh(vm2[2]);
            if (!vo2) continue;
            var found = extractM3u8FromObjVh(vo2, base);
            if (found) return found;
        }
    }

    var fm = code.match(/(?:file)\s*:\s*["']([^"']+\.(?:m3u8|txt)[^"']*?)["']/i);
    if (fm) return makeAbsoluteVh(fm[1], base);
    var am = code.match(/(https?:\/\/[^"'\s\\]+\.(?:m3u8|txt)[^"'\s\\]*)/i);
    if (am) return am[1];
    return null;
}

// Añadidos más dominios mutantes de Streamwish
const EMBED_HOSTS = [
    'streamwish', 'niramirus', 'filemoon', 'embedwish', 'vidhide',
    'vidhideplus', 'wishfast', 'strwish', 'awish', 'flaswish',
    'swdyu', 'embedrise', 'kerapoxy', 'smoothpre', 'fsdcmo',
    'loadpre', 'doodstream', 'voe.sx', 'moon.watch',
    'vidmoly', 'vudeo', 'mp4upload', 'vtube.to', 'upstream',
    'hgplaycdn', 'medixiru'
];

function patchDtoE(url) {
    return url.replace(/\/d\/([A-Za-z0-9]+)(\?|$|#)/, '/e/$1$2').replace(/\/d\/([A-Za-z0-9]+)$/, '/e/$1');
}

// ==========================================
// PROXY DE HLS (m3u8 + segmentos)
// ==========================================
// Por qué existe esto: el master.m3u8 de hgplaycdn/hglamioz/etc lleva un token
// atado a la IP y a los headers (Referer/Origin/UA) que lo "negociaron". Si le
// entregamos esa URL cruda al reproductor (VLC, celular, PC), la petición sale
// desde OTRA IP y el CDN la rechaza aunque los headers estén bien puestos.
// Solución: nuestro propio servidor reproxea TODO (m3u8 y cada segmento .ts),
// siempre con la misma IP/headers, y el reproductor solo habla con nosotros.

function encodeProxyToken(url, headers) {
    return Buffer.from(JSON.stringify({ url: url, headers: headers || {} }), 'utf8').toString('base64url');
}

function decodeProxyToken(token) {
    try {
        return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch (e) { return null; }
}

// Construye la URL absoluta de nuestro proxy que le vamos a dar a Stremio/VLC
// en vez de la URL cruda del CDN.
function buildProxyPlaylistUrl(targetUrl, headers) {
    const token = encodeProxyToken(targetUrl, headers);
    return `${PUBLIC_URL}/hlsproxy/playlist/${token}/master.m3u8`;
}

function isM3u8Url(u) {
    return /\.m3u8(\?|#|$)/i.test(u);
}

// Reescribe un playlist .m3u8: cada línea de URI (sub-playlist o segmento) pasa
// a apuntar a nuestro propio proxy, conservando los headers originales.
//
// IMPORTANTE: no decidimos "sub-playlist vs segmento" por la EXTENSIÓN del
// archivo (algunos sitios, como este, nombran sus sub-playlists con ".txt" en
// vez de ".m3u8"), sino por la ETIQUETA que las precede en el propio m3u8:
// #EXT-X-STREAM-INF siempre indica que la línea siguiente es una sub-playlist,
// sin importar cómo se llame el archivo.
function rewriteM3u8(playlistText, baseUrl, headers) {
    const lines = playlistText.split(/\r?\n/);
    let nextIsPlaylist = false;

    const out = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
            const upper = trimmed.toUpperCase();

            // #EXT-X-I-FRAME-STREAM-INF trae su URI en la misma línea y SIEMPRE
            // apunta a otra sub-playlist (no a un segmento binario).
            if (upper.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
                return line.replace(/URI="([^"]+)"/i, (m, uri) => {
                    const abs = makeAbsoluteVh(uri, baseUrl.replace(/\/[^/]*$/, ''));
                    const token = encodeProxyToken(abs, headers);
                    return `URI="${PUBLIC_URL}/hlsproxy/playlist/${token}/sub.m3u8"`;
                });
            }

            // #EXT-X-KEY / #EXT-X-MAP: su URI sí es un recurso binario (clave de
            // cifrado / segmento de inicialización), va por el proxy de segmentos.
            const rewritten = line.replace(/URI="([^"]+)"/i, (m, uri) => {
                const abs = makeAbsoluteVh(uri, baseUrl.replace(/\/[^/]*$/, ''));
                const token = encodeProxyToken(abs, headers);
                return `URI="${PUBLIC_URL}/hlsproxy/segment/${token}/seg"`;
            });

            // Si esta etiqueta es #EXT-X-STREAM-INF, la línea SIGUIENTE (sin #)
            // va a ser una sub-playlist, aunque su nombre de archivo no diga m3u8.
            nextIsPlaylist = upper.startsWith('#EXT-X-STREAM-INF');
            return rewritten;
        }

        // Línea de URI real (segmento o sub-playlist)
        const absUrl = /^https?:\/\//i.test(trimmed)
            ? trimmed
            : makeAbsoluteVh(trimmed, baseUrl.replace(/\/[^/]*$/, ''));
        const token = encodeProxyToken(absUrl, headers);
        const isPlaylist = nextIsPlaylist || isM3u8Url(absUrl);
        nextIsPlaylist = false;
        return isPlaylist
            ? `${PUBLIC_URL}/hlsproxy/playlist/${token}/sub.m3u8`
            : `${PUBLIC_URL}/hlsproxy/segment/${token}/seg`;
    });
    return out.join('\n');
}

async function handleHlsPlaylistProxy(req, res) {
    const data = decodeProxyToken(req.params.token);
    if (!data) return res.status(400).send('Token inválido');

    try {
        const upstream = await axios.get(data.url, {
            headers: data.headers,
            timeout: 15000,
            responseType: 'text',
            transformResponse: [(d) => d]
        });
        const rewritten = rewriteM3u8(upstream.data, data.url, data.headers);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
    } catch (e) {
        res.status(502).send('No se pudo obtener el playlist');
    }
}

async function handleHlsSegmentProxy(req, res) {
    const data = decodeProxyToken(req.params.token);
    if (!data) return res.status(400).send('Token inválido');

    try {
        const upstream = await axios.get(data.url, {
            headers: data.headers,
            timeout: 20000,
            responseType: 'stream'
        });
        res.set('Access-Control-Allow-Origin', '*');
        if (upstream.headers['content-type']) res.set('Content-Type', upstream.headers['content-type']);
        upstream.data.pipe(res);
    } catch (e) {
        res.status(502).send('No se pudo obtener el segmento');
    }
}

function isEmbedHost(url) {
    for (var i = 0; i < EMBED_HOSTS.length; i++) {
        if (url.indexOf(EMBED_HOSTS[i]) !== -1) return true;
    }
    return false;
}

function parseDownloadTable(html) {
    var results = [];
    var dlRe = /<tr><td><span[^>]*>[^<]*<\/span>\s*([^<]+?)\s*<\/td><td>([^<]+)<\/td><td>[^<]*<span>([^<]+)<\/span>[^<]*<\/td><td><a[^>]+href="(https?:\/\/player\.poseidonhd2\.co\/download\.php[^"]+)"/gi;
    var langMap = { 'latino': 'Latino', 'español': 'Español', 'castellano': 'Español', 'subtitulado': 'Subtitulado', 'english': 'Subtitulado' };
    var m;
    while ((m = dlRe.exec(html)) !== null) {
        var serverRaw = m[1].replace(/^\s+|\s+$/g, '').toLowerCase();
        if (serverRaw !== 'streamwish') continue;
        var langRaw = m[2].replace(/^\s+|\s+$/g, '').toLowerCase();
        var lang = langMap[langRaw] || m[2].replace(/^\s+|\s+$/g, '');
        var quality = m[3].replace(/^\s+|\s+$/g, '') || 'HD';
        results.push({ playerUrl: m[4], label: 'Streamwish · ' + lang + ' · ' + quality + ' (DL)' });
    }
    return results;
}

function parseCliLiStreams(html) {
    var results = [];
    var langMap = { 'español latino': 'Latino', 'latino': 'Latino', 'español': 'Español', 'castellano': 'Español', 'subtitulado': 'Subtitulado', 'english': 'Subtitulado' };
    var groupRe = /_1R6bW_0"[^>]*>\s*<span>([^<]+)[\s\S]*?sub-tab-lang[^"]*"([\s\S]*?)<\/ul>/gi;
    var gm;
    while ((gm = groupRe.exec(html)) !== null) {
        var langRaw = gm[1].replace(/^\s+|\s+$/g, '').toLowerCase();
        var lang = langMap[langRaw] || (langRaw ? (langRaw.charAt(0).toUpperCase() + langRaw.slice(1)) : 'Latino');
        var block = gm[2];
        var cliliRe = /data-tr="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>\s*([^<]+)\s*<\/span>/gi;
        var cm;
        while ((cm = cliliRe.exec(block)) !== null) {
            var playerUrl = cm[1];
            var text = cm[2].replace(/^\s+|\s+$/g, '');
            var serverMatch = text.match(/^\d+\.\s*([^\s-]+)/i);
            if (!serverMatch) continue;
            var serverName = serverMatch[1].toLowerCase();
            if (serverName !== 'vidhide' && serverName !== 'vidhideplus') continue;
            var qualMatch = text.match(/-\s*(\S+)\s*$/i);
            var quality = qualMatch ? qualMatch[1] : 'HD';
            var displayName = serverName === 'vidhideplus' ? 'VidHidePlus' : 'VidHide';
            results.push({ playerUrl: playerUrl, label: displayName + ' · ' + lang + ' · ' + quality });
        }
    }
    return results;
}

function normPsTitle(s) {
    return s.toLowerCase().replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n').replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
}

var PS_STOP = { 'de':1,'la':1,'el':1,'los':1,'las':1,'un':1,'una':1,'en':1,'y':1,'a':1,'the':1,'of':1,'and':1,'del':1,'le':1,'les':1,'des':1,'da':1,'o':1,'e':1 };

function scorePsResult(qWords, tn) {
    if (!qWords.length) return 50;
    var tWords = tn.split(' ');
    var matched = 0;
    for (var qi = 0; qi < qWords.length; qi++) {
        var qw = qWords[qi];
        for (var ti = 0; ti < tWords.length; ti++) {
            var tw = tWords[ti];
            if (!tw) continue;
            if (qw === tw) { matched++; break; }
            if (qw.length >= 5 && tw.length >= 5) {
                var shorter = qw.length <= tw.length ? qw : tw;
                var longer = qw.length <= tw.length ? tw : qw;
                if (longer.indexOf(shorter) === 0 && shorter.length * 10 >= longer.length * 8) { matched++; break; }
            }
        }
    }
    return Math.floor(matched * 80 / qWords.length);
}

// Elige, DENTRO de los resultados del tipo correcto (película o serie), el que
// mejor puntaje de coincidencia tenga contra el título buscado — en vez de tomar
// ciegamente el primero que aparezca en el orden que devolvió el sitio. Esto es
// clave cuando el filtro global ya descartó todo por diferencia de idioma y
// caímos al fallback de orden crudo, donde el primero de un tipo no siempre es
// el correcto (ver caso "Dragon Goes House-Hunting" vs "La casa del dragón").
function pickBestPsMatch(results, query, expectedPath) {
    if (!results || results.length === 0) return null;
    var qn = normPsTitle(query);
    var qRaw = qn.split(' ');
    var qWords = [];
    for (var i = 0; i < qRaw.length; i++) {
        if (qRaw[i].length > 2 && !PS_STOP[qRaw[i]]) qWords.push(qRaw[i]);
    }

    var candidates = expectedPath ? results.filter(r => r.url.indexOf(expectedPath) !== -1) : results;
    if (candidates.length === 0) candidates = results;

    var best = candidates[0];
    var bestScore = -1;
    for (var j = 0; j < candidates.length; j++) {
        var tn = normPsTitle(candidates[j].title);
        var score = (qn === tn) ? 100 : scorePsResult(qWords, tn);
        if (score > bestScore) { bestScore = score; best = candidates[j]; }
    }
    return best;
}

function filterPsResults(results, query) {
    var qn = normPsTitle(query);
    var qRaw = qn.split(' ');
    var qWords = [];
    for (var i = 0; i < qRaw.length; i++) {
        if (qRaw[i].length > 2 && !PS_STOP[qRaw[i]]) qWords.push(qRaw[i]);
    }
    var scored = [];
    for (var j = 0; j < results.length; j++) {
        var tn = normPsTitle(results[j].title);
        var score;
        if (qn === tn) score = 100;
        else if (tn.indexOf(qn) === 0 && (tn.length === qn.length || tn.charAt(qn.length) === ' ')) score = 90;
        else score = scorePsResult(qWords, tn);
        if (score >= 40) scored.push({ r: results[j], score: score });
    }
    scored.sort((a, b) => b.score - a.score);
    // Si nuestro filtrado por palabras no encontró nada (típico cuando el título
    // que buscamos está en un idioma distinto al indexado por el sitio), confiamos
    // en el orden que ya nos dio el buscador de Poseidon en vez de devolver vacío.
    if (scored.length === 0) return results;
    return scored.map(s => s.r);
}

function parseNextData(html) {
    var nm = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!nm) return null;
    try {
        let data = JSON.parse(nm[1]);
        return (data && data.props && data.props.pageProps) ? data.props.pageProps : null;
    } catch(e) { return null; }
}


// ==========================================
// FUNCIONES ASÍNCRONAS (SCRAPERS)
// ==========================================
async function resolveVidHideHls(url) {
    var fileId = null;
    var dm = url.match(/https?:\/\/filelions\.(?:to|tv|com)\/v\/([A-Za-z0-9]+)/i);
    if (dm) {
        fileId = dm[1];
    } else if (url.indexOf('player.poseidonhd2') !== -1 || url.indexOf('player.php') !== -1) {
        var playerHtml;
        try {
            playerHtml = (await axios.get(url, { headers: PS_UA, timeout: 8000 })).data;
        } catch(e) { return null; }
        var m = playerHtml.match(/['"]https?:\/\/filelions\.(?:to|tv|com)\/v\/([A-Za-z0-9]+)['"]/i);
        if (!m) return null;
        fileId = m[1];
    } else {
        return null;
    }

    var base = 'https://callistanise.com';
    var calliPaths = ['/embed/', '/v/'];
    for (var pi = 0; pi < calliPaths.length; pi++) {
        var calliUrl = base + calliPaths[pi] + fileId;
        var calliHtml;
        try {
            calliHtml = (await axios.get(calliUrl, {
                headers: { 'User-Agent': PS_UA['User-Agent'], 'Referer': 'https://filelions.to/' },
                timeout: 8000
            })).data;
        } catch(e) { continue; }
        
        var em = calliHtml.match(/\}\s*\(\s*'([\s\S]+?)',\s*(\d+),\s*(\d+),\s*'([\s\S]+?)'\s*\.split\('\\\|'\)\s*\)/im);
        if (em && em[1] !== undefined && em[2] !== undefined && em[3] !== undefined && em[4] !== undefined) {
            var decoded = unpackJsVh(em[1], parseInt(em[2], 10), parseInt(em[3], 10), em[4].split('|'));
            var hls = extractHlsFromCallistanise(decoded, base);
            if (hls) return hls;
        }
        var hls2 = extractHlsFromCallistanise(calliHtml, base);
        if (hls2) return hls2;
    }
    return null;
}

// --- COMIENZA EL CÓDIGO MODIFICADO ---

async function resolveEmbedUrl(poseidonUrl) {
    var html;
    try {
        html = (await axios.get(poseidonUrl, { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return null; }

    // Regex agresivo: busca cualquier estructura "/e/ID" o "/embed/ID" sin importar el dominio
    var patterns = [
        /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
        /location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
        /<meta[^>]+http-equiv\s*=\s*['"]refresh['"][^>]+content\s*=\s*['"][^'">\s]+url=([^'">\s]+)/i,
        /src\s*=\s*['"]((?:https?:)?\/\/[^'"]+\/(?:e|embed|v)\/[a-zA-Z0-9]+[^'"]*)['"]/i,
        /(https?:\/\/[^\s'"<>\\]+\/(?:e|embed|v)\/[a-zA-Z0-9]+[^\s'"<>\\]*)/i
    ];

    for (var i = 0; i < patterns.length; i++) {
        var m = html.match(patterns[i]);
        if (m && m[1]) return m[1];
    }
    return null;
}

// Detecta si un HTML de un embed hace una redirección client-side (JS o meta refresh)
// hacia otro dominio "mutante" (ej: streamwish.to/e/ID -> niramirus.com/e/ID)
function findMutantRedirect(html, base) {
    var patterns = [
        /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
        /location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
        /<meta[^>]+http-equiv\s*=\s*['"]refresh['"][^>]+content\s*=\s*['"][^'">\s]+url=([^'">\s]+)/i,
        /<iframe[^>]+src\s*=\s*['"]([^'"]+\/(?:e|embed)\/[a-zA-Z0-9]+[^'"]*)['"]/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = html.match(patterns[i]);
        if (m && m[1]) return makeAbsoluteVh(m[1], base);
    }
    return null;
}

// Extrae y desempaqueta cualquier bloque eval(function(p,a,c,k,e,d)...) presente en un HTML
function unpackEvalBlocks(html) {
    var evalRegex = /eval\(\s*function\s*\(p,a,c,k,e,[rd]\)[\s\S]*?\}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\('\|'\)/g;
    var match;
    var unpacked = '';
    while ((match = evalRegex.exec(html)) !== null) {
        var p = match[1];
        var a = parseInt(match[2], 10);
        var c = parseInt(match[3], 10);
        var k = match[4].split('|');
        unpacked += '\n' + unpackJsVh(p, a, c, k);
    }
    return unpacked;
}

// NUEVO: resolvedor específico para la familia Streamwish (streamwish, niramirus,
// embedwish, vidhideplus-clones, filemoon, etc). Sigue la redirección client-side
// hasta el dominio "mutante" final y desempaqueta el player para sacar el m3u8 real.
async function resolveStreamwishHls(embedUrl) {
    var visited = {};
    var currentUrl = embedUrl;
    var refererOrigin = 'https://www.google.com/';

    for (var hop = 0; hop < 4; hop++) {
        if (visited[currentUrl]) break;
        visited[currentUrl] = true;

        var res;
        try {
            res = await axios.get(currentUrl, {
                headers: { ...PS_UA, 'Referer': refererOrigin },
                timeout: 10000
            });
        } catch (e) { return null; }

        var html = res.data;
        var finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || currentUrl;
        var origin = new URL(finalUrl).origin;

        // 1. Intentar sacar el m3u8 directo del HTML/scripts desempaquetados de esta página
        var unpacked = unpackEvalBlocks(html);
        var hls = extractHlsFromCallistanise(unpacked + '\n' + html, origin);
        if (hls) {
            return {
                url: hls,
                headers: { 'Referer': origin + '/', 'Origin': origin, 'User-Agent': PS_UA['User-Agent'] }
            };
        }

        // 2. Si no hay video todavía, ver si la página redirige a un dominio mutante
        var nextUrl = findMutantRedirect(html, origin);
        if (!nextUrl || nextUrl === currentUrl) return null;

        currentUrl = nextUrl;
        refererOrigin = origin + '/';
    }
    return null;
}

// ==========================================
// RESOLUCIÓN CON NAVEGADOR HEADLESS (Puppeteer)
// ==========================================
// Necesario porque streamwish.to/e/ID NO redirige por HTTP ni por un
// window.location.href simple visible en el HTML: el cambio de dominio
// (ej. -> niramirus.com/e/ID) y la carga del .m3u8 ocurren mediante JS
// ejecutado en el navegador (fetch/XHR internos, DOM dinámico, etc).
// axios nunca va a "verlo" porque no ejecuta JavaScript.
// La única forma confiable es abrir la página en un navegador real
// (headless) e interceptar la petición de red hacia el .m3u8 cuando
// el propio player la dispara, tal como pasa cuando lo abrís tú mismo.

let _browserInstance = null;
async function getBrowser() {
    if (_browserInstance && _browserInstance.isConnected()) return _browserInstance;
    _browserInstance = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    return _browserInstance;
}

// Resuelve el .m3u8 real abriendo el embed en un navegador headless,
// siguiendo todos los saltos de dominio que haga el propio JS del sitio,
// e interceptando la request de red hacia el .m3u8 cuando se dispare.
async function resolveStreamwishHlsViaBrowser(embedUrl, timeoutMs, trace) {
    timeoutMs = timeoutMs || 20000;
    let browser;
    let page;
    let onTargetCreated;
    const t = (msg) => { if (trace) trace.push('[' + (Date.now() - tStart) + 'ms] ' + msg); };
    const tStart = Date.now();
    try {
        browser = await getBrowser();
        page = await browser.newPage();
        await page.setUserAgent(PS_UA['User-Agent']);
        await page.setRequestInterception(true);

        let resolved = null;
        let lastRefererByUrl = 'https://www.google.com/';
        let requestCount = 0;
        const seenHosts = new Set();

        onTargetCreated = async (target) => {
            try {
                if (target.opener() === page.target()) {
                    t('Se abrió una pestaña nueva (popup/ad), cerrándola');
                    const popup = await target.page();
                    if (popup) await popup.close();
                }
            } catch (e) { /* noop */ }
        };
        browser.on('targetcreated', onTargetCreated);

        page.on('request', (req) => {
            const url = req.url();
            requestCount++;
            try { seenHosts.add(new URL(url).host); } catch (e) {}
            const type = req.resourceType();
            // OJO: NO abortamos 'media' — el propio <video> puede pedir el .m3u8
            // o los segmentos directamente como resourceType 'media' (sin pasar
            // por hls.js/XHR), y si lo abortamos nunca vemos esa URL ni el video
            // llega a reproducir de verdad. Solo cortamos imágenes/fuentes.
            if (type === 'image' || type === 'font') {
                req.abort();
                return;
            }
            if (/\.m3u8/i.test(url)) t('Request con ".m3u8" en la URL (resourceType=' + type + '): ' + url);
            if (type === 'xhr' || type === 'fetch' || (type === 'media' && !/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url))) {
                t('[' + type + '] ' + url);
            }
            if (!resolved && /\.m3u8(\?|$)/i.test(url)) {
                resolved = {
                    url: url,
                    headers: {
                        'Referer': req.headers()['referer'] || lastRefererByUrl,
                        'Origin': new URL(url).origin,
                        'User-Agent': PS_UA['User-Agent']
                    }
                };
                t('¡MATCH! m3u8 capturado (por URL): ' + url);
            }
            req.continue();
        });

        page.on('response', async (resp) => {
            if (resolved) return;
            try {
                const ct = resp.headers()['content-type'] || '';
                const rUrl = resp.url();
                if (/mpegurl|vnd\.apple\.mpegurl|dash\+xml/i.test(ct)) {
                    resolved = {
                        url: rUrl,
                        headers: {
                            'Referer': resp.request().headers()['referer'] || lastRefererByUrl,
                            'Origin': new URL(rUrl).origin,
                            'User-Agent': PS_UA['User-Agent']
                        }
                    };
                    t('¡MATCH! Manifiesto detectado por content-type "' + ct + '": ' + rUrl);
                }
            } catch (e) { /* noop */ }
        });

        page.on('console', (msg) => {
            if (trace && /error|denied|blocked/i.test(msg.text())) t('console.' + msg.type() + ': ' + msg.text().slice(0, 200));
        });

        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                lastRefererByUrl = frame.url();
                t('Navegó a: ' + frame.url());
            }
        });

        t('Iniciando goto a ' + embedUrl);
        try {
            await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs, referer: 'https://www.google.com/' });
            t('goto completó (domcontentloaded)');
        } catch (e) {
            t('goto tiró error/timeout: ' + e.message);
        }

        const viewport = page.viewport() || { width: 1280, height: 720 };
        const centerX = Math.floor(viewport.width / 2);
        const centerY = Math.floor(viewport.height / 2);

        const start = Date.now();
        let lastClickAt = 0;
        let clickRound = 0;
        while (!resolved && Date.now() - start < timeoutMs) {
            if (Date.now() - lastClickAt > 2000) {
                lastClickAt = Date.now();
                clickRound++;
                try {
                    await page.mouse.click(centerX, centerY);
                    t('Click #' + clickRound + ' en el centro (' + centerX + ',' + centerY + ')');
                } catch (e) { t('Error al clickear centro: ' + e.message); }
                try {
                    const clickedSelector = await page.evaluate(() => {
                        const el = document.querySelector('video, .jw-icon-playback, .vjs-big-play-button, .play-button, #player, .plyr__control--overlaid');
                        if (el) { el.click(); return el.tagName + (el.className ? '.' + el.className : ''); }
                        return null;
                    });
                    if (clickedSelector) t('Click directo sobre elemento: ' + clickedSelector);
                } catch (e) { /* noop */ }
            }
            await new Promise(r => setTimeout(r, 300));
        }

        t('Fin del loop. Requests totales vistos: ' + requestCount + '. Hosts: ' + [...seenHosts].join(', '));
        if (!resolved) {
            try {
                const title = await page.title();
                const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '');
                t('Título de la página: ' + title);
                t('Texto visible (primeros 300 chars): ' + bodyText);
            } catch (e) { /* noop */ }
        }

        return resolved;
    } catch (e) {
        t('ERROR general: ' + e.message);
        return null;
    } finally {
        if (browser && onTargetCreated) {
            try { browser.off('targetcreated', onTargetCreated); } catch (e) {}
        }
        if (page) {
            try { await page.close(); } catch (e) {}
        }
    }
}

// ACTUALIZADO: Retorna no solo la URL, sino también las cabeceras necesarias
async function resolveDirectVideoUrl(embedUrl) {
    try {
        // Obtenemos la página final (siguiendo redirecciones)
        const res = await axios.get(embedUrl, { 
            headers: { ...PS_UA, 'Referer': 'https://www.google.com/' }, 
            timeout: 10000 
        });
        
        let html = res.data;
        const finalUrl = res.request.res.responseUrl || embedUrl;
        const origin = new URL(finalUrl).origin;

        // Intentar unpack (si el sitio está ofuscado)
        const unpackedExtra = unpackEvalBlocks(html);
        const unpackedHtml = html + '\n' + unpackedExtra;

        // Buscar enlaces m3u8 o mp4 (regex corregida: \s ya no excluye la letra "s")
        const fileRegex = /(?:file|src|source)\s*:\s*["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)['"]/i;
        const linkMatch = unpackedHtml.match(fileRegex);
        
        if (linkMatch) {
            return {
                url: linkMatch[1],
                headers: { "Referer": origin + '/', "Origin": origin, "User-Agent": PS_UA['User-Agent'] }
            };
        }
    } catch (err) {
        return null;
    }
    return null;
}

// --- TERMINA EL CÓDIGO MODIFICADO ---

async function searchPoseidon2hd(q) {
    var html;
    try {
        html = (await axios.get('https://www.poseidonhd2.co/search?q=' + encodeURIComponent(q), { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return []; }

    var results = [];
    var seen = {};
    var liRe = /<li[^>]+class="[^"]*TPostMv[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    var item;
    while ((item = liRe.exec(html)) !== null) {
        var block = item[1];
        var aMatch = block.match(/<a\s[^>]*href="(\/pelicula\/[^"]+|\/serie\/[^"]+)"/i);
        if (!aMatch) continue;
        var url = 'https://www.poseidonhd2.co' + aMatch[1];
        if (seen[url]) continue;
        seen[url] = true;

        var tMatch = block.match(/<span[^>]+class="[^"]*Title[^"]*block[^"]*"[^>]*>([^<]+)<\/span>/i);
        if (!tMatch) tMatch = block.match(/<span[^>]+class="[^"]*block[^"]*Title[^"]*"[^>]*>([^<]+)<\/span>/i);
        if (!tMatch) continue;
        var title = tMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (!title) continue;

        results.push({ title: title, url: url });
    }
    return filterPsResults(results, q);
}

async function fetchPoseidonHD2Streams(url, trace) {
    var html;
    try {
        html = (await axios.get(url, { headers: PS_UA, timeout: 8000 })).data;
        if (trace) trace.push('Fetch OK a ' + url + ' (largo HTML: ' + html.length + ')');
    } catch(e) {
        if (trace) trace.push('ERROR fetching ' + url + ': ' + (e.code || e.message) + (e.response ? (' status=' + e.response.status) : ''));
        return null;
    }

    var pp = parseNextData(html);
    if (!pp) {
        if (trace) trace.push('parseNextData no encontró __NEXT_DATA__ o no pudo parsear el JSON');
        return null;
    }
    if (trace) trace.push('parseNextData OK, keys de pageProps: ' + Object.keys(pp).join(', '));

    var subject = pp.thisMovie || pp.thisEpisode || pp.episode || null;
    if (!subject) {
        if (trace) trace.push('Ni pp.thisMovie ni pp.thisEpisode existen en pageProps');
        return null;
    }
    if (trace) trace.push('subject encontrado, keys: ' + Object.keys(subject).join(', '));

    var videos = subject.videos || {};
    if (trace) trace.push('subject.videos: ' + JSON.stringify(videos).slice(0, 800));
    var streams = [];
    var langMap = { spanish: 'Español', latino: 'Latino', english: 'Subtitulado' };
    var langs = ['spanish', 'latino', 'english'];

    for (var li = 0; li < langs.length; li++) {
        var lang = langs[li];
        var entries = videos[lang] || [];
        for (var ei = 0; ei < entries.length; ei++) {
            var e = entries[ei];
            if (!e.result) continue;
            if (e.cyberlocker === 'streamwish' || e.cyberlocker === 'vidhide') {
                var serverName = e.cyberlocker === 'streamwish' ? 'Streamwish' : 'VidHide';
                streams.push({ playerUrl: e.result, label: `${serverName} · ${langMap[lang]} · ${e.quality || 'HD'}` });
            }
        }
    }

    var dlStreams = parseDownloadTable(html);
    var cliStreams = parseCliLiStreams(html);
    if (trace) trace.push('streams de videos[]: ' + streams.length + ', de tabla de descarga: ' + dlStreams.length + ', de cli: ' + cliStreams.length);

    streams = streams.concat(dlStreams).concat(cliStreams);
    return { streams: streams };
}

async function fetchPoseidonHD2Series(url) {
    var html;
    try {
        html = (await axios.get(url, { headers: PS_UA, timeout: 8000 })).data;
    } catch(e) { return null; }

    var pp = parseNextData(html);
    if (!pp) return null;

    var subject = pp.thisSerie || null;
    if (!subject) return null;

    var slugMatch = url.match(/\/serie\/\d+\/([^/?#]+)/);
    return {
        tmdbId: subject.TMDbId ? subject.TMDbId.toString() : null,
        slug: slugMatch ? slugMatch[1] : null
    };
}

async function fetchPoseidonHD2Episode(tmdbId, slug, season, episode, trace) {
    var url = `https://www.poseidonhd2.co/serie/${tmdbId}/${slug}/temporada/${season}/episodio/${episode}`;
    return await fetchPoseidonHD2Streams(url, trace);
}


// ==========================================
// INTEGRACIÓN CON STREMIO ADDON SDK
// ==========================================
const manifest = {
    id: "org.poseidonhd2.stremio",
    version: "1.0.0",
    name: "PoseidonHD2",
    description: "Películas y Series en Español/Latino obtenidas de PoseidonHD",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"] 
};

const builder = new addonBuilder(manifest);

// Stremio suele reintentar automáticamente si un pedido de stream tarda
// mucho en responder -- eso dispara TODO el pipeline de nuevo (incluyendo
// otro navegador Puppeteer), duplicando el trabajo y compitiendo por los
// mismos recursos, lo cual paradójicamente hace que todo tarde AÚN MÁS
// (un círculo vicioso). Para cortarlo: si llega un pedido idéntico
// (mismo type+id) mientras ya hay uno igual en curso, esperamos el MISMO
// resultado en vez de arrancar todo de nuevo desde cero.
const inFlightRequests = new Map();

builder.defineStreamHandler(async (args) => {
    const requestKey = `${args.type}:${args.id}`;
    if (inFlightRequests.has(requestKey)) {
        console.log(`Pedido duplicado detectado para ${requestKey} -- reusando la resolución en curso en vez de arrancar otra.`);
        return inFlightRequests.get(requestKey);
    }

    const resultPromise = resolveStreamRequest(args);
    inFlightRequests.set(requestKey, resultPromise);
    try {
        return await resultPromise;
    } finally {
        inFlightRequests.delete(requestKey);
    }
});

async function resolveStreamRequest(args) {
    const [imdbId, season, episode] = args.id.split(':');
    
    // Cinemeta puede darnos varias variantes de título (nombre original en inglés,
    // y a veces alternativos). Probamos varias para no depender de un solo idioma.
    let titleCandidates = [];
    let tmdbIdFromMeta = null;
    try {
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`);
        const meta = metaRes.data && metaRes.data.meta;
        if (meta) {
            if (meta.moviedb_id) tmdbIdFromMeta = String(meta.moviedb_id);
            if (meta.name) titleCandidates.push(meta.name);
            if (Array.isArray(meta.aka)) titleCandidates = titleCandidates.concat(meta.aka);
            if (meta.slug) {
                const fromSlug = meta.slug.replace(/-\d{4}$/, '').replace(/-/g, ' ').trim();
                if (fromSlug) titleCandidates.push(fromSlug);
            }
        }
    } catch (e) {
        console.log("No se pudo obtener meta de cinemeta para", imdbId);
        return { streams: [] };
    }

    // El ID de TMDB es la forma más confiable de identificar el contenido
    // (determinístico, no depende de idioma ni de coincidencias de texto).
    // Lo pedimos directo a la API de TMDB primero (más confiable que
    // depender de que Cinemeta lo tenga cargado), y si eso falla, usamos el
    // que trajo Cinemeta como respaldo.
    const tmdbResult = await getTmdbId(imdbId, args.type);
    const tmdbId = tmdbResult.id || tmdbIdFromMeta;
    console.log(`imdbId=${imdbId} type=${args.type} tmdbId=${tmdbId} esTitle=${tmdbResult.esTitle}`);

    titleCandidates = [...new Set(titleCandidates.filter(Boolean))];
    // Agregamos el título en español (es-MX) de TMDB como candidato -- el
    // buscador de Poseidon es en español, así que buscar en inglés a veces
    // no encuentra nada aunque el contenido sí esté en el sitio. Lo probamos
    // primero, ya que es más probable que encuentre resultados relevantes.
    if (tmdbResult.esTitle) titleCandidates = [tmdbResult.esTitle, ...titleCandidates.filter(t => t !== tmdbResult.esTitle)];
    if (titleCandidates.length === 0) return { streams: [] };

    console.log('Candidatos de título a probar:', JSON.stringify(titleCandidates));
    // Juntamos los resultados de TODOS los candidatos (no solo el primero que
    // traiga algo), porque el match final es por ID de TMDB exacto -- así que
    // conviene tener el pool más grande posible de resultados donde buscar.
    let searchResults = [];
    let usedCandidate = null;
    const seenUrls = new Set();
    // Las 3 búsquedas se hacen en PARALELO (no una por una) para no perder
    // tiempo -- la latencia de red es lo que domina acá, así que en paralelo
    // el total tarda lo que tarda la más lenta, no la suma de las 3.
    const allResults = await Promise.all(titleCandidates.map(candidate =>
        searchPoseidon2hd(candidate).then(results => {
            console.log(`Búsqueda con "${candidate}" -> ${results.length} resultado(s): ` + JSON.stringify(results.map(r => r.url)));
            return { candidate, results };
        })
    ));
    for (const { candidate, results } of allResults) {
        for (const r of results) {
            if (!seenUrls.has(r.url)) {
                seenUrls.add(r.url);
                searchResults.push(r);
            }
        }
        if (!usedCandidate && results.length > 0) usedCandidate = candidate;
    }
    const expectedPath = args.type === 'series' ? '/serie/' : '/pelicula/';

    if (!searchResults || searchResults.length === 0) {
        // El buscador de Poseidon no encontró NADA con ningún candidato de
        // título -- pasa con estrenos muy recientes que el buscador interno
        // todavía no indexó, aunque la página ya exista. Como Poseidon usa el
        // ID de TMDB en sus URLs (/pelicula/{tmdbId}/{slug}/), si lo tenemos
        // armamos la URL directo y probamos ahí antes de rendirnos.
        if (tmdbId) {
            const guessTitle = (tmdbResult && tmdbResult.esTitle) || usedCandidate || (titleCandidates[0]);
            const guessSlug = slugify(guessTitle);
            const guessUrl = `https://www.poseidonhd2.co${expectedPath}${tmdbId}/${guessSlug}/`;
            console.log(`Sin resultados de búsqueda -- probando URL directa por TMDB ID: ${guessUrl}`);
            searchResults = [{ url: guessUrl, title: guessTitle }];
            usedCandidate = guessTitle;
        } else {
            return { streams: [] };
        }
    }

    // Entre los resultados del tipo correcto (película o serie), buscamos un
    // match EXACTO por ID de TMDB.
    //
    // IMPORTANTE: si tenemos un tmdbId confirmado y NINGÚN resultado de la
    // búsqueda lo tiene, NO caemos al matching por palabras -- eso fue lo que
    // causaba el bug de devolver una serie totalmente distinta cuando la
    // buscada no está en Poseidon. Si Poseidon usa IDs de TMDB en sus URLs y
    // no encontramos ese ID exacto, lo más probable es que ese contenido
    // simplemente no esté en el sitio, así que preferimos devolver vacío.
    // El matching por palabras queda solo como último recurso para el caso
    // (raro) en que ni siquiera tengamos un tmdbId disponible.
    let target = null;
    if (tmdbId) {
        const idRegex = new RegExp(expectedPath + tmdbId + '(?:/|$)');
        target = searchResults.find(r => idRegex.test(r.url)) || null;
        if (!target) {
            console.log(`TMDB ID ${tmdbId} no encontrado en los resultados de Poseidon -- no se arriesga con un match por palabras.`);
            return { streams: [] };
        }
    } else {
        target = pickBestPsMatch(searchResults, usedCandidate, expectedPath);
    }
    if (!target) return { streams: [] };

    let poseidonData = null;

    if (args.type === 'movie') {
        poseidonData = await fetchPoseidonHD2Streams(target.url);
    } else if (args.type === 'series') {
        const seriesData = await fetchPoseidonHD2Series(target.url);
        if (seriesData && seriesData.tmdbId && seriesData.slug) {
            poseidonData = await fetchPoseidonHD2Episode(seriesData.tmdbId, seriesData.slug, season, episode);
        }
    }

    if (!poseidonData || !poseidonData.streams) return { streams: [] };

    const stremioStreams = await Promise.all(poseidonData.streams.map(async (s) => {
        let directUrl = null;
        let cleanLabel = s.label.replace(' (DL)', '');
        
        // 1. Resolver VidHide
        if (s.label.toLowerCase().includes('vidhide')) {
            directUrl = await resolveVidHideHls(s.playerUrl);
            
            if (directUrl) {
                // Reproxeamos también acá: mismo motivo que abajo (token atado a IP/headers).
                return {
                    name: "PoseidonHD",
                    description: cleanLabel,
                    url: buildProxyPlaylistUrl(directUrl, { 'User-Agent': PS_UA['User-Agent'] })
                };
            }
        }

        // 2. Resolver Embeds (Streamwish, Medixiru, etc)
        const embedUrl = await resolveEmbedUrl(s.playerUrl);
        if (embedUrl) {
            // 2a. Intento rápido (sin navegador): sirve para hosts que sí redirigen
            //     con un window.location simple o ya traen el m3u8 en el HTML plano.
            const swDataFast = await resolveStreamwishHls(embedUrl);
            if (swDataFast && swDataFast.url) {
                return {
                    name: "PoseidonHD",
                    description: cleanLabel + "\n(Directo)",
                    url: buildProxyPlaylistUrl(swDataFast.url, swDataFast.headers)
                };
            }

            // 2b. Intento con navegador headless: necesario cuando el salto de
            //     dominio (streamwish.to -> niramirus.com, etc) y la carga del
            //     m3u8 solo ocurren ejecutando el JS real del sitio.
            const swDataBrowser = await resolveStreamwishHlsViaBrowser(embedUrl);
            if (swDataBrowser && swDataBrowser.url) {
                // IMPORTANTE: no le pasamos la URL cruda de hgplaycdn al reproductor.
                // El token del m3u8 quedó atado a la IP/headers con los que
                // Puppeteer lo negoció; si el celular/PC la pide directo, el CDN
                // la rechaza. Por eso TODO pasa por nuestro propio proxy.
                return {
                    name: "PoseidonHD",
                    description: cleanLabel + "\n(Directo)",
                    url: buildProxyPlaylistUrl(swDataBrowser.url, swDataBrowser.headers)
                };
            }

            // 2c. Intento genérico legacy (por si acaso)
            const directData = await resolveDirectVideoUrl(embedUrl);
            if (directData && directData.url) {
                return {
                    name: "PoseidonHD",
                    description: cleanLabel + "\n(Directo)",
                    url: buildProxyPlaylistUrl(directData.url, directData.headers)
                };
            }
            
            // Backup por si falla toda la extracción: si aun así preferís
            // no mostrar streams "External Web", cambiá el return de abajo por `return null;`
            return {
                name: "PoseidonHD",
                description: cleanLabel + "\n(External Web)",
                externalUrl: embedUrl
            };
        }

        return null;
    }));

    return { streams: stremioStreams.filter(stream => stream !== null) };
}

const port = process.env.PORT || 7000;

const app = express();
app.get('/hlsproxy/playlist/:token/*', handleHlsPlaylistProxy);
app.get('/hlsproxy/segment/:token/*', handleHlsSegmentProxy);

// --- DIAGNÓSTICO TEMPORAL para series ---
// Uso: /debug/series?imdb=tt0000000&season=1&episode=1
// --- DIAGNÓSTICO TEMPORAL para embeds tipo streamwish ---
// Uso: /debug/embed?url=<link de streamwish.to/e/xxxx o similar>
app.get('/debug/embed', async (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).send('Falta ?url=');

    res.set('Content-Type', 'text/plain');
    const trace = [];
    const result = await resolveStreamwishHlsViaBrowser(embedUrl, 25000, trace);
    res.send(trace.join('\n') + '\n\nRESULTADO FINAL: ' + JSON.stringify(result));
});
// --- FIN DIAGNÓSTICO TEMPORAL ---

// --- DIAGNÓSTICO TEMPORAL para embeds de Streamwish/hglamioz/playnixes/etc ---
// Uso: /debug/streamwish?url=<embed url completa, ej: https://hgplaycdn.com/e/xxxx>
app.get('/debug/streamwish', async (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).send('Falta ?url=<embed completa>');
    res.set('Content-Type', 'text/plain');

    const trace = [];
    const result = await resolveStreamwishHlsViaBrowser(embedUrl, 25000, trace);
    res.send(trace.join('\n') + '\n\nResultado final: ' + (result ? JSON.stringify(result) : 'null (cayó a External Web)'));
});

app.get('/debug/series', async (req, res) => {
    const imdbId = req.query.imdb;
    const season = req.query.season || '1';
    const episode = req.query.episode || '1';
    if (!imdbId) return res.status(400).send('Falta ?imdb=ttXXXXXXX');

    res.set('Content-Type', 'text/plain');
    const log = [];
    const p = (label, val) => log.push(label + ': ' + (typeof val === 'object' ? JSON.stringify(val) : val));

    try {
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
        const meta = metaRes.data && metaRes.data.meta;
        p('Meta name', meta && meta.name);
        p('Meta slug', meta && meta.slug);
        p('Meta aka', meta && meta.aka);
        p('Meta moviedb_id (TMDB)', meta && meta.moviedb_id);
        const tmdbIdFromMeta = meta && meta.moviedb_id ? String(meta.moviedb_id) : null;

        let titleCandidates = [];
        if (meta) {
            if (meta.name) titleCandidates.push(meta.name);
            if (Array.isArray(meta.aka)) titleCandidates = titleCandidates.concat(meta.aka);
            if (meta.slug) {
                const fromSlug = meta.slug.replace(/-\d{4}$/, '').replace(/-/g, ' ').trim();
                if (fromSlug) titleCandidates.push(fromSlug);
            }
        }
        titleCandidates = [...new Set(titleCandidates.filter(Boolean))];
        p('Candidatos de título', titleCandidates);

        let searchResults = [];
        let usedCandidate = null;
        for (const candidate of titleCandidates) {
            searchResults = await searchPoseidon2hd(candidate);
            p('Búsqueda con "' + candidate + '" dio resultados', searchResults.map(r => r.title + ' -> ' + r.url));
            if (searchResults && searchResults.length > 0) { usedCandidate = candidate; break; }
        }

        if (!searchResults || searchResults.length === 0) {
            return res.send(log.join('\n') + '\n\nNO se encontró NADA en ninguna variante de título.');
        }

        const expectedPath = '/serie/';
        let target = null;
        if (tmdbIdFromMeta) {
            const idRegex = new RegExp(expectedPath + tmdbIdFromMeta + '(?:/|$)');
            target = searchResults.find(r => idRegex.test(r.url)) || null;
            p('Match exacto por TMDB ID (' + tmdbIdFromMeta + ')', target ? target.url : 'NO encontrado');
        }
        if (!target) target = pickBestPsMatch(searchResults, usedCandidate, expectedPath);
        if (!target) return res.send(log.join('\n') + '\n\nNo se encontró ningún resultado.');
        p('Target elegido', target.url + ' (título: ' + target.title + ')');

        const seriesData = await fetchPoseidonHD2Series(target.url);
        p('seriesData (tmdbId/slug)', seriesData);

        if (!seriesData || !seriesData.tmdbId || !seriesData.slug) {
            return res.send(log.join('\n') + '\n\nfetchPoseidonHD2Series no devolvió tmdbId/slug válidos.');
        }

        const episodeUrl = `https://www.poseidonhd2.co/serie/${seriesData.tmdbId}/${seriesData.slug}/temporada/${season}/episodio/${episode}`;
        p('URL de episodio construida', episodeUrl);

        const poseidonData = await fetchPoseidonHD2Episode(seriesData.tmdbId, seriesData.slug, season, episode, log);
        p('poseidonData.streams', poseidonData && poseidonData.streams);

        res.send(log.join('\n'));
    } catch (e) {
        p('ERROR', e.message);
        res.status(500).send(log.join('\n'));
    }
});
// --- FIN DIAGNÓSTICO TEMPORAL ---

// Test de red simple y directo (sin navegador) para ver si el origen responde
// bien a nuestro proxy y qué contenido/status trae realmente.
// Uso: /debug/nettest?url=<tu link completo de /hlsproxy/playlist/TOKEN/master.m3u8>
app.get('/debug/nettest', async (req, res) => {
    const proxyUrl = req.query.url;
    if (!proxyUrl) return res.status(400).send('Falta el parámetro ?url=');

    const m = proxyUrl.match(/\/hlsproxy\/playlist\/([^/]+)\//);
    if (!m) return res.status(400).send('Esa URL no es un link de /hlsproxy/playlist/...');

    const data = decodeProxyToken(m[1]);
    if (!data) return res.status(400).send('No se pudo decodificar el token');

    res.set('Content-Type', 'text/plain');
    const start = Date.now();
    try {
        const upstream = await axios.get(data.url, {
            headers: data.headers,
            timeout: 12000,
            responseType: 'text',
            transformResponse: [(d) => d],
            validateStatus: () => true
        });
        res.send(
            'URL: ' + data.url +
            '\nTiempo: ' + (Date.now() - start) + 'ms' +
            '\nStatus: ' + upstream.status +
            '\nHeaders respuesta: ' + JSON.stringify(upstream.headers, null, 2) +
            '\n\nPrimeros 800 caracteres del body:\n' + String(upstream.data).slice(0, 800)
        );
    } catch (e) {
        res.send(
            'URL: ' + data.url +
            '\nTiempo hasta el error: ' + (Date.now() - start) + 'ms' +
            '\nError code: ' + (e.code || 'N/A') +
            '\nError message: ' + e.message
        );
    }
});

app.use(getRouter(builder.getInterface()));

app.listen(port, () => {
    console.log(`Addon de Stremio escuchando en puerto ${port}`);
    console.log(`PUBLIC_URL usada para el proxy de HLS: ${PUBLIC_URL}`);
});

async function shutdown() {
    if (_browserInstance) {
        try { await _browserInstance.close(); } catch (e) {}
    }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
