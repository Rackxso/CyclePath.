var map, layerGroup, navLayerGroup;

// --- Navigation state ---
var navGraph = null;
var navMode = false;
var navStep = 0; // 1 = waiting for A, 2 = waiting for B
var navMarkerA = null, navMarkerB = null;
var navRouteLine = null;

var QUERY_NAME_TPL = [
  '[out:json][timeout:60];',
  'area["name"="{CITY}"]["boundary"="administrative"]["admin_level"~"^[678]$"]->.a;',
  '(',
  '  way["highway"="cycleway"](area.a);',
  '  way["cycleway"~"lane|track|opposite_lane|opposite_track|shared_lane"](area.a);',
  '  way["cycleway:both"~"lane|track"](area.a);',
  '  way["cycleway:left"~"lane|track"](area.a);',
  '  way["cycleway:right"~"lane|track"](area.a);',
  '  way["highway"~"path|footway"]["bicycle"~"designated|yes"](area.a);',
  ');',
  'out geom;'
].join('\n');

var QUERY_BBOX_TPL = [
  '[out:json][timeout:60];',
  '(',
  '  way["highway"="cycleway"]({BBOX});',
  '  way["cycleway"~"lane|track|opposite_lane|opposite_track|shared_lane"]({BBOX});',
  '  way["cycleway:both"~"lane|track"]({BBOX});',
  '  way["cycleway:left"~"lane|track"]({BBOX});',
  '  way["cycleway:right"~"lane|track"]({BBOX});',
  '  way["highway"~"path|footway"]["bicycle"~"designated|yes"]({BBOX});',
  ');',
  'out geom;'
].join('\n');

var MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

function getColor(tags) {
  var hw = tags.highway || '';
  var cw = tags.cycleway || tags['cycleway:both'] || tags['cycleway:left'] || tags['cycleway:right'] || '';
  if (hw === 'cycleway') return '#1D9E75';
  if (cw === 'track' || cw === 'lane') return '#378ADD';
  return '#D85A30';
}
function getTagClass(tags) {
  var hw = tags.highway || '';
  var cw = tags.cycleway || tags['cycleway:both'] || '';
  if (hw === 'cycleway') return 'tag-green';
  if (cw === 'track' || cw === 'lane') return 'tag-blue';
  return 'tag-orange';
}
function getTypeName(tags) {
  var hw = tags.highway || '';
  var cw = tags.cycleway || tags['cycleway:both'] || tags['cycleway:left'] || tags['cycleway:right'] || '';
  if (hw === 'cycleway') return 'Vía ciclista exclusiva';
  if (cw === 'track') return 'Pista bici segregada';
  if (cw === 'lane') return 'Carril bici en calzada';
  if (cw === 'shared_lane') return 'Carril compartido';
  return 'Acera bici / vía compartida';
}

function flagEmoji(code) {
  if (!code || code.length !== 2) return '🌍';
  return code.toUpperCase().replace(/./g, function(c) {
    return String.fromCodePoint(c.charCodeAt(0) + 127397);
  });
}

function setOverlay(msg) {
  var o = document.getElementById('overlay');
  o.style.display = 'flex';
  o.innerHTML = '<div class="spinner"></div><p>' + msg + '</p>';
}
function hideOverlay() {
  document.getElementById('overlay').style.display = 'none';
}
function showError(msg) {
  var o = document.getElementById('overlay');
  o.style.display = 'flex';
  o.innerHTML = '<div class="error-box"><p>' + msg + '</p></div>';
}

function renderData(data, cityName) {
  layerGroup.clearLayers();
  var elements = data.elements || [];
  var count = 0;
  var bounds = [];
  elements.forEach(function(el) {
    if (el.type !== 'way' || !el.geometry) return;
    var latlngs = el.geometry.map(function(p) { return [p.lat, p.lon]; });
    var tags = el.tags || {};
    var cw = tags.cycleway || tags['cycleway:both'] || '';
    var opts = {
      color: getColor(tags),
      weight: tags.highway === 'cycleway' ? 4 : 3,
      opacity: 0.85
    };
    if (cw === 'shared_lane') opts.dashArray = '6,4';
    var line = L.polyline(latlngs, opts).addTo(layerGroup);
    var name = tags.name ? '<b>' + tags.name + '</b>' : '<b>Tramo sin nombre</b>';
    var surface = tags.surface ? '<span>Superficie: ' + tags.surface + '</span>' : '';
    line.bindPopup(name + '<span class="tag ' + getTagClass(tags) + '">' + getTypeName(tags) + '</span>' + surface);
    latlngs.forEach(function(p) { bounds.push(p); });
    count++;
  });

  if (bounds.length > 0) map.fitBounds(bounds, { padding: [30, 30] });
  hideOverlay();

  // Build routing graph from downloaded data
  clearNav();
  navGraph = elements.length > 0 ? buildGraph(elements) : null;

  if (count === 0) {
    document.getElementById('status').textContent = 'Sin datos de carriles bici en ' + cityName + ' (o ciudad no encontrada)';
    showError('No se encontraron carriles bici en <b>' + cityName + '</b>.<br><br>Prueba con el nombre oficial de la ciudad o una ciudad más grande.');
  } else {
    document.getElementById('status').textContent = count + ' tramos encontrados en ' + cityName;
  }
}

function tryMirror(mirrors, idx, query, cityName) {
  if (idx >= mirrors.length) {
    showError('No se pudo conectar con Overpass API.<br><br>Si abres el archivo como <code>file://</code>, usa un servidor local:<br><code>python3 -m http.server 8080</code>');
    document.getElementById('status').textContent = 'Error de conexión';
    return;
  }
  setOverlay('Cargando carriles bici de ' + cityName + '...');
  fetch(mirrors[idx], {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query)
  })
  .then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then(function(data) {
    renderData(data, cityName);
  })
  .catch(function() {
    tryMirror(mirrors, idx + 1, query, cityName);
  });
}

function loadCity(cityName, bbox) {
  var query;
  if (bbox) {
    // Nominatim bbox: [south, north, west, east] → Overpass: south,west,north,east
    var bboxStr = bbox[0] + ',' + bbox[2] + ',' + bbox[1] + ',' + bbox[3];
    query = QUERY_BBOX_TPL.replace(/\{BBOX\}/g, bboxStr);
    map.fitBounds([
      [parseFloat(bbox[0]), parseFloat(bbox[2])],
      [parseFloat(bbox[1]), parseFloat(bbox[3])]
    ], { padding: [20, 20], animate: true });
  } else {
    query = QUERY_NAME_TPL.replace('{CITY}', cityName);
  }
  document.getElementById('status').textContent = 'Buscando ' + cityName + '...';
  tryMirror(MIRRORS, 0, query, cityName);
}

// Autocomplete with Nominatim (worldwide)
var suggestTimeout;
var cityInput = document.getElementById('city-input');
var suggestionsEl = document.getElementById('suggestions');
var activeSuggIdx = -1;

cityInput.addEventListener('input', function() {
  clearTimeout(suggestTimeout);
  var val = cityInput.value.trim();
  if (val.length < 3) { suggestionsEl.style.display = 'none'; return; }
  suggestTimeout = setTimeout(function() { fetchSuggestions(val); }, 300);
});

cityInput.addEventListener('keydown', function(e) {
  var items = suggestionsEl.querySelectorAll('li');
  if (e.key === 'ArrowDown') {
    activeSuggIdx = Math.min(activeSuggIdx + 1, items.length - 1);
    updateActive(items);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    activeSuggIdx = Math.max(activeSuggIdx - 1, -1);
    updateActive(items);
    e.preventDefault();
  } else if (e.key === 'Enter') {
    if (activeSuggIdx >= 0 && items[activeSuggIdx]) {
      items[activeSuggIdx].click();
    } else {
      doSearch();
    }
  } else if (e.key === 'Escape') {
    suggestionsEl.style.display = 'none';
    activeSuggIdx = -1;
  }
});

function updateActive(items) {
  items.forEach(function(li, i) {
    li.classList.toggle('active', i === activeSuggIdx);
  });
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#search-float')) {
    suggestionsEl.style.display = 'none';
    activeSuggIdx = -1;
  }
});

function fetchSuggestions(val) {
  var url = 'https://nominatim.openstreetmap.org/search'
    + '?q=' + encodeURIComponent(val)
    + '&featureType=city'
    + '&format=json'
    + '&limit=8'
    + '&accept-language=es'
    + '&addressdetails=1';

  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(results) {
      activeSuggIdx = -1;
      suggestionsEl.innerHTML = '';
      if (!results.length) { suggestionsEl.style.display = 'none'; return; }
      results.forEach(function(r) {
        var li = document.createElement('li');
        var cityName = r.name || r.display_name.split(',')[0].trim();
        var addr = r.address || {};
        var country = addr.country || '';
        var countryCode = addr.country_code || '';
        var flag = flagEmoji(countryCode);
        var region = addr.state || addr.county || addr.region || '';
        var detail = [region, country].filter(Boolean).join(', ');

        li.innerHTML =
          '<span class="sugg-flag">' + flag + '</span>' +
          '<span class="sugg-text">' +
            '<span class="sugg-name">' + cityName + '</span>' +
            (detail ? '<span class="sugg-detail">' + detail + '</span>' : '') +
          '</span>';

        li.addEventListener('click', function() {
          cityInput.value = cityName;
          suggestionsEl.style.display = 'none';
          activeSuggIdx = -1;
          loadCity(cityName, r.boundingbox);
        });
        suggestionsEl.appendChild(li);
      });
      suggestionsEl.style.display = 'block';
    })
    .catch(function() { suggestionsEl.style.display = 'none'; });
}

function doSearch() {
  var val = cityInput.value.trim();
  if (!val) return;
  suggestionsEl.style.display = 'none';
  activeSuggIdx = -1;
  loadCity(val, null);
}

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([40.0, -3.7], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);
  navLayerGroup = L.layerGroup().addTo(map);

  map.on('click', onMapClick);

  cityInput.value = 'Córdoba';
  loadCity('Córdoba', null);
}

// ─── Graph / routing ────────────────────────────────────────────────────────

function haversine(a, b) {
  var R = 6371000;
  var dLat = (b[0] - a[0]) * Math.PI / 180;
  var dLon = (b[1] - a[1]) * Math.PI / 180;
  var lat1 = a[0] * Math.PI / 180;
  var lat2 = b[0] * Math.PI / 180;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Simple binary min-heap keyed on .f
class MinHeap {
  constructor() { this.d = []; }
  push(item) {
    this.d.push(item);
    var i = this.d.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (this.d[p].f <= this.d[i].f) break;
      var t = this.d[p]; this.d[p] = this.d[i]; this.d[i] = t;
      i = p;
    }
  }
  pop() {
    var top = this.d[0], last = this.d.pop();
    if (this.d.length > 0) {
      this.d[0] = last;
      var i = 0, n = this.d.length;
      while (true) {
        var l = 2 * i + 1, r = 2 * i + 2, s = i;
        if (l < n && this.d[l].f < this.d[s].f) s = l;
        if (r < n && this.d[r].f < this.d[s].f) s = r;
        if (s === i) break;
        var t = this.d[s]; this.d[s] = this.d[i]; this.d[i] = t;
        i = s;
      }
    }
    return top;
  }
  size() { return this.d.length; }
}

function buildGraph(elements) {
  var nodes = [];
  var nodeIndex = {};
  var adj = [];
  var CELL = 0.0005; // ~55 m grid cells
  var grid = {};

  function gk(lat, lon) {
    return Math.floor(lat / CELL) + ',' + Math.floor(lon / CELL);
  }
  function addNode(lat, lon) {
    var key = lat.toFixed(6) + ',' + lon.toFixed(6);
    if (nodeIndex[key] !== undefined) return nodeIndex[key];
    var idx = nodes.length;
    nodes.push([lat, lon]);
    adj.push([]);
    nodeIndex[key] = idx;
    var k = gk(lat, lon);
    if (!grid[k]) grid[k] = [];
    grid[k].push(idx);
    return idx;
  }
  function addEdge(i, j) {
    var d = haversine(nodes[i], nodes[j]);
    adj[i].push({ to: j, dist: d });
    adj[j].push({ to: i, dist: d });
  }

  // Add way edges
  elements.forEach(function(el) {
    if (el.type !== 'way' || !el.geometry) return;
    var prev = -1;
    el.geometry.forEach(function(p) {
      var idx = addNode(p.lat, p.lon);
      if (prev >= 0) addEdge(prev, idx);
      prev = idx;
    });
  });

  // Connect nodes within 30 m across different ways
  var RADIUS = 30;
  nodes.forEach(function(node, i) {
    var cx = Math.floor(node[0] / CELL);
    var cy = Math.floor(node[1] / CELL);
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        var k = (cx + dx) + ',' + (cy + dy);
        if (!grid[k]) continue;
        grid[k].forEach(function(j) {
          if (j <= i) return;
          if (haversine(node, nodes[j]) <= RADIUS) {
            if (!adj[i].some(function(e) { return e.to === j; })) addEdge(i, j);
          }
        });
      }
    }
  });

  return { nodes: nodes, adj: adj, grid: grid, CELL: CELL };
}

function nearestNode(graph, lat, lon) {
  var best = -1, bestDist = Infinity;
  var pt = [lat, lon];
  var CELL = graph.CELL;
  var cx = Math.floor(lat / CELL), cy = Math.floor(lon / CELL);
  for (var r = 0; r <= 8; r++) {
    for (var dx = -r; dx <= r; dx++) {
      for (var dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        var k = (cx + dx) + ',' + (cy + dy);
        if (!graph.grid[k]) continue;
        graph.grid[k].forEach(function(idx) {
          var d = haversine(pt, graph.nodes[idx]);
          if (d < bestDist) { bestDist = d; best = idx; }
        });
      }
    }
    if (best >= 0 && bestDist < (r + 1) * CELL * 111000) break;
  }
  return best;
}

function astarRoute(graph, startIdx, endIdx) {
  var nodes = graph.nodes, adj = graph.adj, n = nodes.length;
  var dist = new Float64Array(n).fill(Infinity);
  var prev = new Int32Array(n).fill(-1);
  var visited = new Uint8Array(n);
  var goal = nodes[endIdx];
  var heap = new MinHeap();
  dist[startIdx] = 0;
  heap.push({ idx: startIdx, f: 0 });

  while (heap.size() > 0) {
    var cur = heap.pop();
    var u = cur.idx;
    if (visited[u]) continue;
    visited[u] = 1;
    if (u === endIdx) break;
    var edges = adj[u];
    for (var i = 0; i < edges.length; i++) {
      var v = edges[i].to;
      if (visited[v]) continue;
      var nd = dist[u] + edges[i].dist;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push({ idx: v, f: nd + haversine(nodes[v], goal) });
      }
    }
  }

  if (dist[endIdx] === Infinity) return null;
  var path = [];
  for (var c = endIdx; c !== -1; c = prev[c]) path.unshift(c);
  return { path: path, dist: dist[endIdx] };
}

// ─── Navigation UI ──────────────────────────────────────────────────────────

function toggleNav() {
  if (!navGraph) {
    alert('Carga una ciudad primero para poder navegar.');
    return;
  }
  navMode = !navMode;
  var btn = document.getElementById('nav-btn');
  if (navMode) {
    btn.classList.add('active');
    map.getContainer().style.cursor = 'crosshair';
    clearNavMarkers();
    navStep = 1;
    showNavPanel('<span class="nav-point nav-point-a">A</span> Haz clic en el mapa para marcar el <strong>origen</strong>');
  } else {
    clearNav();
  }
}

function clearNavMarkers() {
  if (navMarkerA) { navLayerGroup.removeLayer(navMarkerA); navMarkerA = null; }
  if (navMarkerB) { navLayerGroup.removeLayer(navMarkerB); navMarkerB = null; }
  if (navRouteLine) { navLayerGroup.removeLayer(navRouteLine); navRouteLine = null; }
}

function clearNav() {
  navMode = false;
  navStep = 0;
  clearNavMarkers();
  map.getContainer().style.cursor = '';
  document.getElementById('nav-btn').classList.remove('active');
  document.getElementById('nav-panel').style.display = 'none';
}

function showNavPanel(statusHtml, resultHtml) {
  var panel = document.getElementById('nav-panel');
  panel.style.display = 'block';
  document.getElementById('nav-status-text').innerHTML = statusHtml || '';
  var res = document.getElementById('nav-result-text');
  if (resultHtml) { res.innerHTML = resultHtml; res.style.display = 'block'; }
  else { res.innerHTML = ''; res.style.display = 'none'; }
}

function makeNavIcon(label, color) {
  return L.divIcon({
    className: '',
    html: '<div style="width:28px;height:28px;border-radius:50%;background:' + color + ';color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3)">' + label + '</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
}

function onMapClick(e) {
  if (!navMode) return;
  var lat = e.latlng.lat, lon = e.latlng.lng;

  if (navStep === 1) {
    if (navMarkerA) navLayerGroup.removeLayer(navMarkerA);
    navMarkerA = L.marker([lat, lon], { icon: makeNavIcon('A', '#1D9E75') }).addTo(navLayerGroup);
    navStep = 2;
    showNavPanel('<span class="nav-point nav-point-b">B</span> Ahora haz clic para marcar el <strong>destino</strong>');

  } else if (navStep === 2) {
    if (navMarkerB) navLayerGroup.removeLayer(navMarkerB);
    navMarkerB = L.marker([lat, lon], { icon: makeNavIcon('B', '#D85A30') }).addTo(navLayerGroup);
    showNavPanel('Calculando ruta...');
    computeRoute(navMarkerA.getLatLng(), e.latlng);
    navStep = 0; // reset so user can click again to recalculate
    setTimeout(function() { if (navMode) navStep = 1; }, 100);
  }
}

function computeRoute(latlngA, latlngB) {
  if (!navGraph) return;
  var idxA = nearestNode(navGraph, latlngA.lat, latlngA.lng);
  var idxB = nearestNode(navGraph, latlngB.lat, latlngB.lng);
  if (idxA < 0 || idxB < 0) {
    showNavPanel('Sin carriles bici cercanos al punto seleccionado.');
    return;
  }
  if (idxA === idxB) {
    showNavPanel('Origen y destino están en el mismo tramo.');
    return;
  }

  var result = astarRoute(navGraph, idxA, idxB);
  if (navRouteLine) { navLayerGroup.removeLayer(navRouteLine); navRouteLine = null; }

  if (!result) {
    showNavPanel(
      '<span class="nav-point nav-point-a">A</span>→<span class="nav-point nav-point-b" style="margin-left:4px">B</span> Sin ruta',
      '⚠️ No hay conexión entre los tramos. La red de carriles bici de esta zona puede tener huecos mayores de 30 m.'
    );
    return;
  }

  var latlngs = result.path.map(function(i) { return navGraph.nodes[i]; });
  navRouteLine = L.polyline(latlngs, { color: '#7B2FF7', weight: 5, opacity: 0.9 }).addTo(navLayerGroup);

  var km = (result.dist / 1000).toFixed(2);
  var min = Math.ceil(result.dist / 1000 / 15 * 60); // ~15 km/h en bici
  showNavPanel(
    '<span class="nav-point nav-point-a">A</span>→<span class="nav-point nav-point-b" style="margin-left:4px">B</span> Ruta encontrada',
    '📏 <strong>' + km + ' km</strong> &nbsp;·&nbsp; ⏱ ~<strong>' + min + ' min</strong> en bici'
  );
}
