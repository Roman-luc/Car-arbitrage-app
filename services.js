
const { chromium } = require("playwright");

const COUNTRY_NAMES = { LT: "Lithuania", DE: "Germany", PL: "Poland" };
const SOURCES = { LT: { name: "Autoplius" }, DE: { name: "mobile.de" }, PL: { name: "Otomoto" } };

const PLN_TO_EUR = 0.23;

function normalizeText(s){ return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function norm(s){ return String(s || "").trim().toLowerCase(); }
function num(text){ const d = String(text || "").replace(/[^\d]/g, ""); return d ? Number(d) : null; }

function extractYear(text){
  const t = normalizeText(text);
  // Find all candidate years — must be standalone 4-digit numbers in range 1980-2030
  // Exclude years that are immediately followed by more digits (e.g. part of a price)
  const matches = [...t.matchAll(/\b(19[89]\d|20[0-2]\d)\b(?!\d)/g)];
  if (!matches.length) return null;
  // If multiple years found, pick the most common one (mode), not the first
  const freq = {};
  for (const m of matches) {
    const yr = Number(m[1]);
    freq[yr] = (freq[yr] || 0) + 1;
  }
  return Number(Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0]);
}

// Extract mileage in km from listing text
function extractMileage(text){
  const t = normalizeText(text);
  // Patterns: "120 000 km", "120000 km", "120,000 km", "120.000 km", "120 tkm", "120 tūkst. km"
  const patterns = [
    /(\d[\d\s.,]{2,})\s*(km)/ig,
    /(\d+)\s*t(?:ūkst\.?|ys\.?|kst\.?|km)\b/ig,  // Lithuanian "tūkst. km" = thousand km
    /(\d+)\s*tys\.\s*km/ig,   // Polish "tys. km"
    /(\d+)\s*Tkm\b/ig,
  ];
  const candidates = [];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      let v = num(m[1]);
      if (!v) continue;
      // "tūkst" / "tys" means thousands
      if (/tūkst|tys|tkm/i.test(m[0]) && v < 1000) v *= 1000;
      if (v >= 1000 && v <= 600000) candidates.push(v);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a,b)=>a-b);
  // Pick the median to avoid e.g. engine displacement (1600) being confused with mileage
  return candidates[Math.floor(candidates.length / 2)];
}

function inferFuel(text){ const t = normalizeText(text).toLowerCase(); if (/(diesel|dīzel|tdi|cdi|dci|olej)/i.test(t)) return "Diesel"; if (/(petrol|benz|benzin|tsi|tfsi|benzyna)/i.test(t)) return "Petrol"; if (/(hybrid|hybryda)/i.test(t)) return "Hybrid"; if (/(electric|elektr|bev\b)/i.test(t)) return "Electric"; return ""; }
function inferGearbox(text){ const t = normalizeText(text).toLowerCase(); if (/(automatic|automat|dsg|automatyczna|tiptronic|s.tronic)/i.test(t)) return "Automatic"; if (/(manual|mechan|rankinis|manualna)/i.test(t)) return "Manual"; return ""; }
function inferDrive(text){ const t = normalizeText(text).toLowerCase(); if (/(awd|4x4|4wd|quattro|xdrive)/i.test(t)) return "AWD"; if (/(rwd|rear.wheel)/i.test(t)) return "RWD"; if (/(fwd|front.wheel)/i.test(t)) return "FWD"; return ""; }

function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

const DAMAGE_PATTERNS = [
  /damaged/i,
  /dented/i,
  /crashed/i,
  /broken/i,
  /accident(?:ed)?/i,
  /write[ -]?off/i,
  /salvage/i,
  /repairable/i,
  /non[- ]runner/i,
  /for parts/i,
  /dauz(?:tas|ta|ti)?/i,
  /mustas/i,
  /mushtas/i,
  /defekt(?:as|u)?/i,
  /su defektu/i,
  /nevažiuoj\w*/i,
  /nevaziuoj\w*/i,
  /neveikian\w*/i,
  /po avarij\w*/i,
  /po eismo ivykio/i,
  /uszkodzon\w*/i,
  /rozbity/i,
  /bity/i,
  /powypadkow\w*/i,
  /po wypadku/i,
  /po kolizji/i,
  /niesprawn\w*/i,
  /niejezdn\w*/i,
  /do naprawy/i,
  /uszk\.? silnik/i,
  /beschädigt/i,
  /defekt/i,
  /unfallwagen/i,
  /fahruntüchtig/i,
  /nicht fahrbereit/i,
  /reparaturbedürftig/i,
];

function isDamagedListing(item){
  const text = normalizeText([item.title, item.raw, item.priceText].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return false;
  if (/bezwypadkow\w*/i.test(text) || /be avarij\w*/i.test(text) || /without accidents?/i.test(text) || /accident free/i.test(text) || /unfallfrei/i.test(text)) {
    const reduced = text
      .replace(/bezwypadkow\w*/ig, ' ')
      .replace(/be avarij\w*/ig, ' ')
      .replace(/without accidents?/ig, ' ')
      .replace(/accident free/ig, ' ')
      .replace(/unfallfrei/ig, ' ');
    return DAMAGE_PATTERNS.some((re) => re.test(reduced));
  }
  return DAMAGE_PATTERNS.some((re) => re.test(text));
}

// Bucket mileage into 20k bands: 0-20k, 20-40k, ..., 280-300k, 300k+
function mileageBracket(km){
  if (!km || km < 1000) return null;
  if (km >= 300000) return "300k+";
  const band = Math.floor(km / 20000) * 20;
  return band + "k-" + (band + 20) + "k";
}
function bracketRange(bracket){
  if (!bracket) return null;
  if (bracket === "300k+") return { from: 300000, to: 600000 };
  const m = bracket.match(/^(\d+)k-(\d+)k$/);
  if (!m) return null;
  return { from: Number(m[1]) * 1000, to: Number(m[2]) * 1000 - 1 };
}
function median(arr){
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : Math.round((s[m-1]+s[m])/2);
}
function mode(arr){
  if (!arr.length) return null;
  const freq = {};
  for (const v of arr) freq[v] = (freq[v]||0)+1;
  return Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
}

function buildQuery(filters){ return [filters.make, filters.model, filters.year, filters.fuel, filters.gearbox, filters.drive].filter(Boolean).join(" "); }

function slug(s){ return String(s||"").toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,""); }


function getAutopliusMakeEntry(make){
  const AUTOPLIUS_IDS = {
    "BMW":            { makeId: 97,  models: { "SERIA-1": 1318, "SERIA-2": 1320, "SERIA-3": 1319, "SERIA-4": 1321, "SERIA-5": 1313, "SERIA-6": 1316, "SERIA-7": 1315, "SERIA-8": 1323, "X1": 1326, "X3": 1327, "X4": 1328, "X5": 1324, "X6": 1325, "M3": 1310, "M5": 1309, "Z4": 1314 } },
    "Audi":           { makeId: 99,  models: { "A3": 1341, "A4": 1340, "A5": 1343, "A6": 1339, "A7": 1344, "A8": 1338, "Q3": 10858, "Q5": 10856, "Q7": 10854, "TT": 1345 } },
    "Volkswagen":     { makeId: 43,  models: { "GOLF": 193, "PASSAT": 186, "TIGUAN": 10737, "TOUAREG": 198, "TOURAN": 10736, "POLO": 191, "CADDY": 10730, "TRANSPORTER": 199, "MULTIVAN": 10731, "SHARAN": 197, "JETTA": 188 } },
    "Mercedes-Benz":  { makeId: 67,  models: { "C-CLASS": 685, "E-CLASS": 682, "S-CLASS": 679, "A-CLASS": 686, "B-CLASS": 684, "GLC": 25133, "GLE": 22807, "GLA": 22810, "GLK": 11150, "ML": 683, "CLA": 11145, "CLS": 681 } },
    "Opel":           { makeId: 35,  models: { "ASTRA": 137, "INSIGNIA": 11019, "VECTRA": 144, "ZAFIRA": 145, "MERIVA": 10998, "MOKKA": 22692, "CORSA": 134 } },
    "Ford":           { makeId: 18,  models: { "FOCUS": 52, "MONDEO": 57, "KUGA": 10942, "FIESTA": 51, "GALAXY": 53, "S-MAX": 10941, "TRANSIT": 63 } },
    "Toyota":         { makeId: 40,  models: { "COROLLA": 170, "AVENSIS": 164, "RAV4": 175, "AURIS": 10868, "YARIS": 180, "PRIUS": 173, "CAMRY": 166, "LAND-CRUISER": 172 } },
    "Volvo":          { makeId: 42,  models: { "V70": 184, "XC90": 12444, "XC60": 12442, "S60": 181, "V60": 12441, "S80": 182, "V50": 12440, "V40": 12439, "XC70": 183 } },
    "Skoda":          { makeId: 48,  models: { "OCTAVIA": 157, "SUPERB": 159, "FABIA": 155, "KODIAQ": 25025, "KAROQ": 25026, "RAPID": 22742, "YETI": 22741 } },
    "Renault":        { makeId: 36,  models: { "MEGANE": 124, "LAGUNA": 120, "SCENIC": 126, "KANGOO": 119, "CLIO": 116, "ESPACE": 117 } },
    "Peugeot":        { makeId: 34,  models: { "307": 112, "308": 22639, "406": 113, "407": 22637, "508": 22638, "3008": 22640, "5008": 22641 } },
    "Nissan":         { makeId: 33,  models: { "QASHQAI": 10829, "X-TRAIL": 109, "JUKE": 22632, "NOTE": 10828, "MICRA": 104, "LEAF": 22630 } },
    "Mazda":          { makeId: 26,  models: { "6": 80, "3": 75, "CX-5": 22592, "CX-3": 22594, "5": 78 } },
    "Hyundai":        { makeId: 20,  models: { "I30": 10947, "TUCSON": 67, "SANTA-FE": 64, "IX35": 10948, "I20": 10946 } },
    "Kia":            { makeId: 23,  models: { "SPORTAGE": 10975, "CEED": 10973, "SORENTO": 91, "RIO": 10974 } },
    "Honda":          { makeId: 19,  models: { "CIVIC": 60, "ACCORD": 58, "CR-V": 61, "JAZZ": 10944 } },
    "Seat":           { makeId: 44,  models: { "LEON": 147, "IBIZA": 146, "ATECA": 25071 } },
    "Subaru":         { makeId: 49,  models: { "OUTBACK": 161, "FORESTER": 160, "IMPREZA": 162, "LEGACY": 163 } },
    "Mitsubishi":     { makeId: 29,  models: { "OUTLANDER": 10816, "ASX": 22601, "LANCER": 95, "GALANT": 93 } },
    "Jeep":           { makeId: 22,  models: { "GRAND-CHEROKEE": 73, "CHEROKEE": 72, "COMPASS": 22579, "RENEGADE": 22580 } },
    "Land Rover":     { makeId: 25,  models: { "DISCOVERY": 77, "FREELANDER": 78, "RANGE-ROVER": 80, "DEFENDER": 76 } },
    "Porsche":        { makeId: 37,  models: { "CAYENNE": 128, "911": 127, "PANAMERA": 22644, "MACAN": 22645 } },
  };
  const makeKey = Object.keys(AUTOPLIUS_IDS).find(k => k.toLowerCase() === String(make || '').toLowerCase());
  return makeKey ? AUTOPLIUS_IDS[makeKey] : null;
}

function getAutopliusModelMeta(make, model){
  const entry = getAutopliusMakeEntry(make);
  if (!entry) return { entry: null, modelId: null, queryTerm: model || '', exactMakeModelParam: null, makeIdList: null };
  const modelUp = String(model || '').toUpperCase();
  let modelId = entry.models[modelUp] || null;
  let queryTerm = model || '';
  let exactMakeModelParam = null;
  let makeIdList = null;

  if (!modelId) {
    const aliases = { "SERIE-3": "SERIA-3", "SERIE-5": "SERIA-5", "C-KLASE": "C-CLASS", "E-KLASE": "E-CLASS" };
    const aliased = aliases[modelUp];
    if (aliased) modelId = entry.models[aliased] || null;
  }

  if (String(make || '').toLowerCase() === 'bmw') {
    const exactVariantMap = {
      '318': { exactMakeModelParam: '1319_10936', makeIdList: '97', modelId: 1319 },
    };
    const exact = exactVariantMap[modelUp];
    if (exact) {
      exactMakeModelParam = exact.exactMakeModelParam;
      makeIdList = exact.makeIdList;
      if (!modelId && exact.modelId) modelId = exact.modelId;
      queryTerm = model || queryTerm;
    }
  }

  if (!modelId && String(make || '').toLowerCase() === 'bmw') {
    const family = getModelFamilyKey(model, make).replace(/^BMW-/, '');
    modelId = entry.models[family] || null;
    queryTerm = model || family.replace(/^SERIA-/, '');
  }

  return { entry, modelId, queryTerm, exactMakeModelParam, makeIdList };
}

function getBaseModelSearchTerm(make, model){
  const raw = normalizeText(model).toUpperCase();
  if (!raw) return "";

  const makeNorm = normalizeText(make).toLowerCase();
  const tokens = raw.split(/\s+/).filter(Boolean);

  // Audi: keep only the core model token for link searches.
  // "A4 B8", "A6 ALLROAD", "Q5 S-LINE" should search as A4 / A6 / Q5.
  if (makeNorm === "audi") {
    const audiToken = tokens.find(t => /^(A\d|Q\d|TT|R8|E-TRON|SQ\d|RS\d|S\d)$/i.test(t));
    if (audiToken) return audiToken;
  }

  // BMW: keep exact variant if present (320, 530, X5, M5). If we only have
  // a family label, map it to a human text query that Otomoto understands.
  if (makeNorm === "bmw") {
    const bmwToken = tokens.find(t => /^(\d{3}[A-Z]?|X\d|XM|Z\d|I\d|IX|M\d)$/i.test(t));
    if (bmwToken) return bmwToken;
    const exact = raw.match(/\b(\d{3})(?:D|I|XD|XI)?\b/i);
    if (exact) return exact[1];
    const family = raw.match(/(?:SERIA|SERIES)[- ]?(\d)/i);
    if (family) return `SERIA ${family[1]}`;
  }

  // Mercedes: turn C-CLASS / E-CLASS into C / E class queries.
  const merc = raw.match(/^([A-Z]+)[- ]CLASS$/i);
  if (merc) return `${merc[1]} CLASS`;

  // Generic fallback: first short alnum token usually gives the best results
  // on Otomoto and avoids over-filtering with trim names.
  const generic = tokens.find(t => /^[A-Z0-9-]{1,12}$/.test(t));
  return generic || raw;
}

function widenMileageRange(range, extraKm = 20000){
  if (!range) return null;
  const from = Math.max(0, Number(range.from || 0) - extraKm);
  const to = Math.min(600000, Number(range.to || 600000) + extraKm);
  return { from, to };
}

function mileageWindowFromReference(bracket, repMileage, halfWindowKm = 8000){
  if (repMileage && repMileage >= 1000) {
    return {
      from: Math.max(0, Math.round(repMileage - halfWindowKm)),
      to: Math.min(600000, Math.round(repMileage + halfWindowKm)),
    };
  }
  return bracket ? bracketRange(bracket) : null;
}

function buildOtomotoBasePath(make, model){
  const makePart = slug(make);
  if (!makePart) return 'https://www.otomoto.pl/osobowe';
  const modelSlug = model ? otomotoSlug(make, model) : '';
  return modelSlug
    ? `https://www.otomoto.pl/osobowe/${makePart}/${modelSlug}`
    : `https://www.otomoto.pl/osobowe/${makePart}`;
}

function buildSearchUrl(country, filters, pageNo = 1){
  const make = (filters.make || "").trim();
  const model = (filters.model || "").trim();
  const combinedQuery = [make, model].filter(Boolean).join(" ").trim();

  switch (country) {
    case "LT": {
      const meta = getAutopliusModelMeta(make, model);
      let base;
      if (meta.entry) {
        if (meta.exactMakeModelParam && meta.makeIdList) {
          base = `https://autoplius.lt/skelbimai/naudoti-automobiliai?category_id=2&make_id%5B${meta.entry.makeId}%5D=${meta.exactMakeModelParam}&make_id_list=${meta.makeIdList}`;
          if (model) base += `&qt=${encodeURIComponent(model)}`;
        } else {
          base = `https://autoplius.lt/skelbimai/naudoti-automobiliai?category_id=2&make_id=${meta.entry.makeId}`;
          if (model && meta.modelId) base += `&model_id=${meta.modelId}`;
          const qt = model ? model : make;
          if (qt) base += `&qt=${encodeURIComponent(qt)}`;
        }
      } else {
        const q = encodeURIComponent(combinedQuery || make);
        base = `https://autoplius.lt/skelbimai/naudoti-automobiliai?category_id=2&qt=${q}`;
      }
      if (filters.year) {
        base += `&make_date_from=${encodeURIComponent(filters.year)}&make_date_to=${encodeURIComponent(filters.year)}`;
      }
      return pageNo === 1 ? base : `${base}&page_nr=${pageNo}`;
    }
    case "DE": {
      const q = encodeURIComponent(buildQuery(filters));
      return pageNo === 1
        ? `https://suchen.mobile.de/fahrzeuge/search.html?isSearchRequest=true&q=${q}`
        : `https://suchen.mobile.de/fahrzeuge/search.html?isSearchRequest=true&pageNumber=${pageNo - 1}&q=${q}`;
    }
    case "PL": {
      let base = buildOtomotoBasePath(make, model);
      const parts = [];
      const plModelTerm = getBaseModelSearchTerm(make, model);
      if (plModelTerm) {
        const qSlug = slug(plModelTerm);
        if (qSlug && !base.includes(`/q-${qSlug}`)) base += `/q-${qSlug}`;
      }
      if (combinedQuery) parts.push(`search%5Bquery%5D=${encodeURIComponent(combinedQuery)}`);
      if (filters.year) {
        parts.push(`search%5Bfilter_float_year%3Afrom%5D=${encodeURIComponent(filters.year)}`);
        parts.push(`search%5Bfilter_float_year%3Ato%5D=${encodeURIComponent(filters.year)}`);
      }
      if (pageNo > 1) parts.push(`page=${pageNo}`);
      return parts.length ? `${base}?${parts.join("&")}` : base;
    }
    default: return "";
  }
}

// Build a model-specific search URL using each site's real filter params,
// pre-filtered to year ±2 and mileage ±30% of the representative listing pool.
// Otomoto uses internal model slugs that don't match the model names we detect.
// e.g. "530" -> "seria-5", "320" -> "seria-3", "X5" -> "x5", "M5" -> "m5"
// Rather than maintain a full mapping, we use the make-only path and pass
// model as a text search param which Otomoto does support via search[filter_enum_model].
// For Autoplius, only params confirmed from live page hrefs are used.
function buildModelSearchUrl(country, filters, model, yr, bracket, repMileage, repFuel, repGearbox){
  const make = (filters.make || "").trim();
  const year = (yr && yr >= 1985 && yr <= 2030) ? yr : null;
  const mi   = mileageWindowFromReference(bracket, repMileage, country === "LT" ? 30000 : 20000);

  switch (country) {
    case "LT": {
      const meta = getAutopliusModelMeta(make, model);
      const isBmwNumeric = String(make || '').toLowerCase() === 'bmw' && /^\d{3}[a-z]?$/i.test(String(model || ''));
      if (meta.entry) {
        let url;
        if (meta.exactMakeModelParam && meta.makeIdList) {
          url = `https://autoplius.lt/skelbimai/naudoti-automobiliai?category_id=2&make_id%5B${meta.entry.makeId}%5D=${meta.exactMakeModelParam}&make_id_list=${meta.makeIdList}`;
          if (model) url += "&qt=" + encodeURIComponent(String(model).trim());
        } else {
          const base = "https://autoplius.lt/skelbimai/naudoti-automobiliai?category_id=2&make_id=" + meta.entry.makeId;
          url = (!isBmwNumeric && meta.modelId) ? base + "&model_id=" + meta.modelId : base;
          const qtParts = [make, meta.queryTerm || model].filter(Boolean);
          if (qtParts.length) url += "&qt=" + encodeURIComponent(qtParts.join(" "));
        }
        if (year) { url += "&make_date_from=" + year + "&make_date_to=" + year; }
        if (mi)   { url += "&kilometrage_from=" + mi.from + "&kilometrage_to=" + mi.to; }
        return url;
      }

      const q = encodeURIComponent([make, model].filter(Boolean).join(" "));
      let url = "https://autoplius.lt/skelbimai/naudoti-automobiliai?category_id=2&qt=" + q;
      if (year) { url += "&make_date_from=" + year + "&make_date_to=" + year; }
      if (mi)   { url += "&kilometrage_from=" + mi.from + "&kilometrage_to=" + mi.to; }
      return url;
    }
    case "DE": {
      const q = encodeURIComponent([make, model].filter(Boolean).join(" "));
      let url = "https://suchen.mobile.de/fahrzeuge/search.html?isSearchRequest=true&q=" + q;
      if (year) url += "&firstRegistration.min=" + year + "-1&firstRegistration.max=" + year + "-12";
      if (mi)   url += "&minMileage=" + mi.from + "&maxMileage=" + mi.to;
      return url;
    }
    case "PL": {
      let base = buildOtomotoBasePath(make, model);
      const parts = [];
      let modelTerm = getBaseModelSearchTerm(make, model) || model;
      if (String(make || '').toLowerCase() === 'bmw' && /^\d{3}[a-z]?$/i.test(String(modelTerm || ''))) {
        const suffix = /diesel/i.test(String(repFuel || '')) ? 'd' : /petrol/i.test(String(repFuel || '')) ? 'i' : '';
        modelTerm = String(modelTerm) + suffix;
      }
      const qSlug = slug(modelTerm);
      if (qSlug && !base.includes(`/q-${qSlug}`)) base += `/q-${qSlug}`;
      let query = [make, modelTerm].filter(Boolean).join(' ').trim();
      if (repFuel) query += ' ' + repFuel;
      if (repGearbox) query += ' ' + repGearbox;
      if (query) parts.push("search%5Bquery%5D=" + encodeURIComponent(query));
      if (year) {
        parts.push("search%5Bfilter_float_year%3Afrom%5D=" + year);
        parts.push("search%5Bfilter_float_year%3Ato%5D=" + year);
      }
      if (mi) {
        parts.push("search%5Bfilter_float_mileage%3Afrom%5D=" + mi.from);
        parts.push("search%5Bfilter_float_mileage%3Ato%5D=" + mi.to);
      }
      return parts.length ? base + "?" + parts.join("&") : base;
    }
    default: return "";
  }
}

function otomotoVersionSlug(make, model, fuel){
  if (String(make || '').toLowerCase() !== 'bmw') return '';
  const m = String(model || '').toLowerCase();
  const match = m.match(/^(\d{3})([a-z]?)$/i);
  if (!match) return '';
  const suffix = /diesel/i.test(String(fuel || '')) ? 'd' : /petrol/i.test(String(fuel || '')) ? 'i' : match[2];
  return 'ver-' + match[1] + (suffix || '');
}

// Normalize a model name to a canonical group key used by both sites.
// Ensures BMW "320", "318", "325" all map to "SERIA-3" to match Otomoto's path slug.
function normalizeModelKey(model, make) {
  if (!model) return "";
  const cleaned = model.toString().trim().replace(/\s+/g, " ");
  const upper = cleaned.toUpperCase().replace(/\s+/g, "-");

  // Keep exact BMW variants when we can infer them from the title.
  // Grouping 320/330/520 into generic series made the results too broad
  // and produced search links that often opened empty Autoplius pages.
  if ((make || "").toLowerCase() === "bmw") {
    if (/^(SERIA|SERIES)-\d$/i.test(upper)) return upper;
    if (/^(\d{3}[A-Z]?|X\d|XM|Z\d|I\d|IX|M\d)$/i.test(upper)) return upper;
  }

  return upper;
}

// Convert Otomoto URL model slug to normalized model key
function otomotoSlugToModel(slug) {
  if (!slug) return "";
  return slug.toUpperCase();  // normalizeModelKey will be applied later in normalizeListing
}

function otomotoSlug(make, model) {
  if (!model) return "";
  const m = model.toLowerCase();
  if (make.toLowerCase() === "bmw") {
    const BMW_SERIES = {
      "1": ["116","118","120","123","125","128","130","135","140","m135","m140"],
      "2": ["214","216","218","220","225","228","230","235","240","m235","m240"],
      "3": ["316","318","320","323","325","328","330","335","340","m3"],
      "4": ["418","420","425","428","430","435","440","m4"],
      "5": ["518","520","523","525","528","530","535","540","545","550","m5"],
      "6": ["625","630","635","640","645","650","m6"],
      "7": ["725","728","730","735","740","745","750","760"],
      "8": ["840","850","m8"],
    };
    for (const [n, nums] of Object.entries(BMW_SERIES)) {
      if (nums.includes(m)) return "seria-" + n;
    }
  }
  return model.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function getPriceCandidates(text, country){
  const t = normalizeText(text);
  const matches = [];
  // Use structured regex: 1-3 digits then optional groups of exactly 3 digits,
  // preceded by a non-alphanumeric char to avoid grabbing trailing digits from words like "Seria 5 45 000"
  const curPL = /(?<![a-zA-Z0-9])(\d{1,3}(?:[\s\u00a0·\u202f]\d{3})*|\d+)\s*(zł|PLN)/gi;
  const curEU = /(?<![a-zA-Z0-9])(\d{1,3}(?:[\s.,]\d{3})*|\d+)\s*(€|EUR)/gi;
  const cur = country === "PL" ? curPL : curEU;
  for (const m of t.matchAll(cur)) {
    const v = num(m[1]);
    if (v) matches.push(v);
  }
  // Only use fallback number extraction if no currency symbol found at all
  if (!matches.length) {
    // Strict fallback: only grab numbers that look like prices (4-6 digits, no adjacent letters)
    const nums = t.match(/(?<![a-zA-Z0-9])\d{4,6}(?!\d)/g) || [];
    for (const x of nums) { const v = num(x); if (v) matches.push(v); }
  }
  return matches;
}

function chooseBestPrice(text, country){
  let prices = getPriceCandidates(text, country).filter(v => {
    if (country === "PL") return v >= 6500 && v <= 600000;
    return v >= 1500 && v <= 200000;
  }).sort((a,b)=>a-b);
  if (!prices.length) return null;
  let raw;
  if (prices.length === 1) {
    raw = prices[0];
  } else {
    const med = prices[Math.floor(prices.length/2)];
    const sane = prices.filter(v => v <= Math.max(200000, med * 2));
    raw = sane.length ? sane[0] : med;
  }
  return country === "PL" ? Math.round(raw * PLN_TO_EUR) : raw;
}

function inferModelFromTitle(title, make){
  const t = normalizeText(title);
  const makeNorm = normalizeText(make).toLowerCase();
  let rest = t.toLowerCase();
  if (makeNorm && rest.includes(makeNorm)) {
    rest = rest.slice(rest.indexOf(makeNorm) + makeNorm.length).trim();
  }
  if (!rest) return "";
  const tokens = rest.split(" ").filter(Boolean);
  if (!tokens.length) return "";
  const first  = tokens[0].replace(/[^a-z0-9-]/gi, "");
  const second = (tokens[1] || "").replace(/[^a-z0-9-]/gi, "");

  const knownModels = new Set([
    "x1","x2","x3","x4","x5","x6","x7","m2","m3","m4","m5","m8","z4","i4","i7","ix",
    "q2","q3","q5","q7","q8","e-tron",
    "a1","a3","a4","a5","a6","a7","a8","tt","r8","rs3","rs4","rs5","rs6","rs7","sq5","sq7",
    "v40","v60","v90","xc40","xc60","xc90","s60","s90","c30","c40","ex30","ex90",
    "i10","i20","i30","i40","ioniq","kona","tucson","santa-fe",
    "cx-3","cx-5","cx-30","cx-60","cx-80","cx-90","mx-5",
    "cr-v","hr-v","jazz","civic","accord","pilot","zr-v",
    "gla","glb","glc","gle","gls","cla","cls","eqc","eqa","eqe","eqs",
    "3008","5008","2008","508","408","308","208","4008",
    "tiguan","touareg","passat","golf","polo","arteon","id4","id3","id5","touran","sharan","caddy","t-roc","t-cross",
    "octavia","superb","kodiaq","karoq","scala","fabia","enyaq","kamiq",
    "ioniq5","ioniq6","nexo",
    "yaris","corolla","rav4","camry","prius","auris","avensis","chr","supra","bz4x",
    "clio","megane","kadjar","captur","scenic","koleos","arkana","zoe","austral",
    "focus","fiesta","puma","kuga","mondeo","mustang","galaxy","s-max","mach-e",
  ]);

  if (knownModels.has(first.toLowerCase())) return first.toUpperCase();
  if (/^\d{3}[a-z]?$/i.test(first)) return first.toUpperCase();
  if (/^[a-z]\d$/i.test(first)) return first.toUpperCase();
  if (["seria","series","klasse","clase","classe","a-class","b-class","c-class","e-class","s-class"].includes(first.toLowerCase()) && second) return `${first} ${second}`;
  const bodyStyles = new Set(["sedan","wagon","suv","manual","automatic","diesel","petrol","hybrid","electric","hatchback","estate","coupe","cabriolet","convertible","kombi","allroad","benzinas","dyzelis","tdi","tfsi","tsi","fsi","dci","cdi","sport","line","plus","pack","style","design","business","edition","limited","premium","luxury","base","entry","avant"]);
  if (second && /^[a-z0-9-]{1,14}$/i.test(second) && !bodyStyles.has(second.toLowerCase())) {
    return `${first} ${second}`.trim();
  }
  return first;
}


function inferExactVariantFromText(make, text){
  const t = normalizeText(text);
  const makeNorm = normalizeText(make).toLowerCase();

  if (makeNorm === "bmw") {
    // Prefer exact numeric/X/M variants over broad series labels.
    // Examples: "BMW Seria 3 320d" -> 320, "BMW X5 xDrive30d" -> X5
    const xOrM = t.match(/\b(X\d|XM|M\d|Z\d|I\d|IX)\b/i);
    if (xOrM) return xOrM[1].toUpperCase();
    const num = t.match(/\b(\d{3})(?:\s*[dix]{0,3})\b/i);
    if (num) return num[1].toUpperCase();
  }

  if (makeNorm === "audi") {
    const audi = t.match(/\b(A\d|Q\d|TT|R8|E-TRON|SQ\d|RS\d|S\d)\b/i);
    if (audi) return audi[1].toUpperCase();
  }

  return "";
}

function normalizeListing(raw, sourceName, filters, country){
  const text = normalizeText(raw.raw || raw.title || "");
  // Preserve a structured card-level price string when we have one.
  // For Otomoto this should be something like "89 900 PLN" and is more trustworthy
  // than scanning the whole card text, which may include financing/helper numbers.
  const priceText = raw.priceText ? normalizeText(raw.priceText) : text;

  // Year resolution:
  // 1. Use pre-extracted year from URL slug or DOM element (always reliable)
  // 2. Only fall back to extractYear(text) for DE — LT and PL embed year in URL slug
  //    so text-based extraction is never needed and often wrong (prices, phone numbers)
  let year = raw.year ? Number(raw.year) : null;
  if (!year && country === "DE") {
    year = extractYear(text);
  }
  const currentYear = new Date().getFullYear();
  const validYear = (year && year >= 1985 && year <= currentYear + 1) ? year : null;

  return {
    source: sourceName,
    url: raw.url,
    title: normalizeText(raw.title || text || buildQuery(filters)),
    make: filters.make || "",
    model: (() => {
      // For Otomoto (PL), broad family labels like "Seria 3" are not enough.
      // Prefer extracting exact variants such as 320/520 from title/raw text.
      const exactVariant = inferExactVariantFromText(filters.make || "", [raw.title, text].filter(Boolean).join(" "));
      if (exactVariant) return normalizeModelKey(exactVariant, filters.make || "");
      if (country === "PL" && raw.modelSlugFromUrl) {
        return normalizeModelKey(raw.modelSlugFromUrl, filters.make || "");
      }
      const titleGuess = inferModelFromTitle(raw.title || text, filters.make || "");
      const rawGuess = (country === "PL" && !titleGuess) ? inferModelFromTitle(text, filters.make || "") : "";
      const inferred = normalizeModelKey(titleGuess || rawGuess, filters.make || "");
      return inferred || (country === "PL" ? filters.model || "" : "") || filters.model || "";
    })(),
    year: validYear,
    fuel: raw.fuel || inferFuel(text) || filters.fuel || "",
    gearbox: raw.gearbox || inferGearbox(text) || filters.gearbox || "",
    drive: raw.drive || inferDrive(text) || filters.drive || "",
    mileage: raw.mileage || extractMileage(text),
    priceEur: (() => {
      if (country === "PL") {
        // For Otomoto, trust the strict card-level extraction first. Broad text parsing can be polluted
        // by helper numbers on the card.
        if (raw.priceEur) return raw.priceEur;
        const exactFromText = raw.priceText ? chooseBestPrice(normalizeText(raw.priceText), country) : null;
        return exactFromText || chooseBestPrice(priceText, country);
      }
      return raw.priceEur || chooseBestPrice(priceText, country);
    })(),
    priceText: priceText.slice(0, 60),  // keep for debug logging
    raw: text
  };
}


function getModelFamilyKey(model, make){
  const upper = String(model || "").toUpperCase();
  if ((make || "").toLowerCase() === "bmw") {
    const familyMap = new Map([
      ["1", ["116","118","120","123","125","128","130","135","140","M135","M140","SERIA-1","SERIES-1"]],
      ["2", ["214","216","218","220","225","228","230","235","240","M235","M240","SERIA-2","SERIES-2"]],
      ["3", ["316","318","320","323","325","328","330","335","340","M3","SERIA-3","SERIES-3"]],
      ["4", ["418","420","425","428","430","435","440","M4","SERIA-4","SERIES-4"]],
      ["5", ["518","520","523","525","528","530","535","540","545","550","M5","SERIA-5","SERIES-5"]],
      ["6", ["625","630","635","640","645","650","M6","SERIA-6","SERIES-6"]],
      ["7", ["725","728","730","735","740","745","750","760","SERIA-7","SERIES-7"]],
      ["8", ["840","850","M8","SERIA-8","SERIES-8"]],
    ]);
    for (const [family, variants] of familyMap.entries()) {
      if (variants.includes(upper)) return `BMW-SERIA-${family}`;
    }
  }
  return upper;
}

function dedupe(list){
  const seen = new Set();
  return list.filter(x => {
    const k = `${normalizeText(x.url)}|${x.priceEur}|${normalizeText(x.title).slice(0,80)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function matchFilters(item, filters){
  if (filters.model && norm(item.model) !== norm(filters.model)) return false;
  if (filters.year && item.year && item.year !== Number(filters.year)) return false;
  if (filters.priceFrom && item.priceEur && item.priceEur < Number(filters.priceFrom)) return false;
  if (filters.priceTo && item.priceEur && item.priceEur > Number(filters.priceTo)) return false;
  if (filters.fuel && item.fuel && item.fuel !== filters.fuel) return false;
  if (filters.gearbox && item.gearbox && item.gearbox !== filters.gearbox) return false;
  if (filters.drive && item.drive && item.drive !== filters.drive) return false;
  return true;
}

// Derive representative stats from a group of listings to power accurate search links
function deriveGroupStats(listings){
  const years     = listings.map(x=>x.year).filter(Boolean);
  const fuels     = listings.map(x=>x.fuel).filter(Boolean);
  const gearboxes = listings.map(x=>x.gearbox).filter(Boolean);
  const mileages  = listings.map(x=>x.mileage).filter(Boolean);

  return {
    year:           years.length     ? Number(mode(years))     : null,
    fuel:           fuels.length     ? mode(fuels)             : null,
    gearbox:        gearboxes.length ? mode(gearboxes)         : null,
    mileageMedian:  mileages.length  ? median(mileages)        : null,
  };
}

function countMileageBrackets(listings){
  const counts = new Map();
  for (const item of listings) {
    const bracket = mileageBracket(item.mileage);
    if (!bracket) continue;
    counts.set(bracket, (counts.get(bracket) || 0) + 1);
  }
  return counts;
}

function mileageDistance(a, b){
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const ra = bracketRange(a);
  const rb = bracketRange(b);
  if (!ra || !rb) return Number.POSITIVE_INFINITY;
  const ca = (ra.from + ra.to) / 2;
  const cb = (rb.from + rb.to) / 2;
  return Math.abs(ca - cb);
}

function pickSharedMileageBracket(buyGroup, sellGroup){
  const buyCounts = countMileageBrackets(buyGroup);
  const sellCounts = countMileageBrackets(sellGroup);
  const shared = [];

  for (const [bracket, buyCount] of buyCounts.entries()) {
    const sellCount = sellCounts.get(bracket) || 0;
    if (!sellCount) continue;
    shared.push({
      bracket,
      score: Math.min(buyCount, sellCount),
      total: buyCount + sellCount,
      buyCount,
      sellCount,
    });
  }

  if (shared.length) {
    shared.sort((a, b) => b.score - a.score || b.total - a.total || a.bracket.localeCompare(b.bracket));
    return shared[0].bracket;
  }

  const buyMedian = median(buyGroup.map(x => x.mileage).filter(Boolean));
  const sellMedian = median(sellGroup.map(x => x.mileage).filter(Boolean));
  if (!buyMedian || !sellMedian) return null;

  const buyBracket = mileageBracket(buyMedian);
  const sellBracket = mileageBracket(sellMedian);
  if (!buyBracket || !sellBracket) return null;

  const dist = mileageDistance(buyBracket, sellBracket);
  if (dist <= 40000) {
    return buyMedian <= sellMedian ? buyBracket : sellBracket;
  }

  return null;
}

function filterGroupToMileageBracket(listings, bracket){
  if (!bracket) return listings;
  return listings.filter(x => mileageBracket(x.mileage) === bracket);
}

async function acceptCookiesIfPresent(page){
  const selectors = [
    "#onetrust-accept-btn-handler",
    "[data-testid='button-accept-all']",
    ".cookie-consent__agree",
    "button[id*='accept-all']",
    "button[id*='acceptAll']",
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(700);
        return;
      }
    } catch {}
  }
  const labels = [
    "Accept all","Accept","I agree","Zgadzam","Akceptuję","Akceptuj wszystkie","Zgoda",
    "Alle akzeptieren","Zustimmen","Einverstanden","Allow all","Zaakceptuj"
  ];
  for (const txt of labels) {
    try {
      const btn = page.getByRole("button", { name: new RegExp(`^${txt}`, "i") }).first();
      if (await btn.isVisible({ timeout: 600 })) {
        await btn.click({ timeout: 800 });
        await page.waitForTimeout(600);
        return;
      }
    } catch {}
  }
}

async function scrapeSinglePage(page, searchUrl, country){
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    if (country !== "PL") throw err;
    await page.waitForTimeout(1500).catch(() => {});
    try {
      await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 });
    } catch (err2) {
      throw err2;
    }
  }
  if (country === "PL") {
    // Step 1: dismiss cookie consent FIRST — Otomoto blocks listing render until accepted
    await page.waitForTimeout(2500);
    await acceptCookiesIfPresent(page);
    await page.waitForTimeout(1500);
    // Step 2: wait for listing links to appear after consent (React SPA)
    try {
      await page.waitForSelector("a[href*='/oferta/']", { timeout: 20000 });
    } catch {
      try { await page.waitForSelector("article, [data-testid]", { timeout: 8000 }); } catch {}
    }
    // Step 3: scroll to trigger lazy-loaded cards
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  } else {
    await page.waitForTimeout(2000);
    await acceptCookiesIfPresent(page);
    await page.waitForTimeout(800);
  }

    // Debug: log page title and grab hrefs to detect bot blocks
  const pageTitle = await page.title().catch(() => "");
  const debugHrefs = await page.evaluate(({ country }) => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map(a => a.getAttribute("href") || "")
      .filter(Boolean)
      .slice(0, 80);
  }, { country });
  // Emit page title for diagnosis — bot-blocked pages often have titles like "Access Denied"
  if (pageTitle) { /* pageTitle available in outer scope for emit */ }

  return await page.evaluate(({ country, searchUrl, debugHrefs, plnToEur }) => {
    function keepHref(href) {
      if (!href) return false;
      if (country === "LT") {
        if (/\/skelbimai\/[^/?#]+-\d{7,}\.html/.test(href)) return true;
        if (/\/skelbimas\/\d{4,}/.test(href)) return true;
        if (/\/announcement\//.test(href)) return true;
        return false;
      }
      if (country === "DE") {
        return href.includes("/fahrzeuge/details.html") ||
               href.includes("/vehicle/") ||
               /\/\d{8,}\.html/.test(href);
      }
      if (country === "PL") {
        return href.includes("/oferta/") ||
               /\/osobowe\/[^/]+\/[^/]+\/[^/]+-\d+\.html/.test(href) ||
               /\/osobowe\/[^/]+-\d+\.html/.test(href);
      }
      return false;
    }

    function txt(el){ return el ? el.innerText.replace(/\s+/g, " ").trim() : ""; }

    // Per-site structured field extraction
    function extractListing(a, absoluteUrl) {
      if (country === "LT") {
        // Autoplius card structure (confirmed from page inspection):
        //   .announcement-item or li.announcement wraps each card
        //   .title-year  → year
        //   .price-value → price
        //   The listing URL slug contains year+fuel:
        //   bmw-530-3-0-l-universalas-2015-dyzelinas-30218691.html
        const card = a.closest("li, article, .announcement-item, .announcement") || a;
        const rawText = txt(card).slice(0, 600);

        // URL slug is the most reliable source — always present, never noisy
        // Format: bmw-530-3-0-l-universalas-2015-dyzelinas-30218691.html
        const slugMatch = absoluteUrl.match(/\/skelbimai\/(.+?)\.html/);
        const slug = slugMatch ? slugMatch[1] : "";
        const slugYearMatch = slug.match(/\b(19[89]\d|20[0-2]\d)\b/);
        const yearFromSlug = slugYearMatch ? slugYearMatch[1] : null;

        // Also try DOM element — contains "2015-07" format, extract just the year part
        const yearEl = card.querySelector(".title-year");
        const yearElText = yearEl ? yearEl.innerText.trim() : "";
        const yearElMatch = yearElText.match(/\b(19[89]\d|20[0-2]\d)\b/);
        const yearFromEl = yearElMatch ? yearElMatch[1] : null;

        // Slug year takes priority — it's part of the canonical URL
        const year = yearFromSlug || yearFromEl;

        // Fuel from slug: dyzelinas=Diesel, benzinas=Petrol, elektra=Electric, hibridas=Hybrid
        let fuel = "";
        if (/dyzelinas|dyzelis/.test(slug)) fuel = "Diesel";
        else if (/benzinas|benzin/.test(slug)) fuel = "Petrol";
        else if (/elektra/.test(slug)) fuel = "Electric";
        else if (/hibridas/.test(slug)) fuel = "Hybrid";

        // Price: prefer visible price nodes. data-amount often belongs to finance widgets
        // and can produce wrong averages.
        const priceSelectors = [
          ".announcement-item-price",
          ".announcement-price",
          ".price-value",
          "[data-testid='price']",
          "[data-testid*='price-value']",
        ];
        let priceText = "";
        const parseEuro = (t) => {
          const m = String(t || '').match(/(\d{1,3}(?:[\s.,]\d{3})*|\d+)\s*(?:€|EUR)/i);
          return m ? Number(String(m[1]).replace(/[^\d]/g, '')) : 0;
        };
        let bestPriceVal = 0;
        for (const sel of priceSelectors) {
          const nodes = Array.from(card.querySelectorAll(sel));
          for (const el of nodes) {
            const v = el ? txt(el) : "";
            const pv = parseEuro(v);
            if (v && /€|eur/i.test(v) && pv > bestPriceVal) {
              bestPriceVal = pv;
              priceText = v;
            }
          }
        }
        if (!priceText) {
          const euroHits = rawText.match(/\d{1,3}(?:[\s.,]\d{3})*\s*(?:€|EUR)/gi) || [];
          if (euroHits.length) {
            priceText = euroHits.sort((a,b)=>parseEuro(b)-parseEuro(a))[0];
          }
        }
        if (!priceText) priceText = rawText;

        return { url: absoluteUrl, title: txt(a), raw: rawText, year, fuel, priceText };
      }

      if (country === "DE") {
        const card = a.closest("article, li, .result-item, [class*='listing']") || a;
        const rawText = txt(card);
        return { url: absoluteUrl, title: txt(a), raw: rawText };
      }

      if (country === "PL") {
        // Otomoto current URL format: /osobowe/oferta/audi-a4-...-RANDOMID.html
        // No make/model in path — model must come from card text
        const card = a.closest("article, [data-testid], li") || a;
        const rawText = txt(card).slice(0, 800);  // cap to prevent memory crash

        // Year: extract from card text, excluding engine displacement like "1998 cm3"
        // Strategy: find all year candidates, reject any immediately followed by "cm" or "ccm"
        const currentYr = new Date().getFullYear();
        const yearCandidates = [...rawText.matchAll(/\b(19[89]\d|20[0-2]\d)\b(?!\d)/g)];
        let year = null;
        for (const m of yearCandidates) {
          const after = rawText.slice(m.index + 4, m.index + 10).toLowerCase();
          if (/^\s*c[cm]/.test(after)) continue;  // skip "1998 cm3", "1998 ccm"
          if (/^\s*km/.test(after)) continue;      // skip mileage-like numbers
          year = String(m[1]);
          break;
        }

        // Model: no longer in URL — inferred from title in normalizeListing
        const modelSlugFromUrl = null;

        // Title: prefer heading element over anchor text (anchor may just be the URL)
        const titleEl = card.querySelector("h2, h3, [class*='Title'], [class*='title']");
        const titleText = titleEl ? txt(titleEl) : txt(a);

        // Price: extract as strictly as possible from the dedicated price block first.
        // Search-card text contains many helper numbers, so we should not rely on broad text scans
        // when a card-level price block exists.
        const cardHtml = card.innerHTML || "";
        let priceValueText = "";
        let priceCurrencyText = "";

        const strictHtmlMatch = cardHtml.match(/<h3[^>]*class=["'][^"']*ooa-3ewd90[^"']*["'][^>]*>\s*([\d\s ]+)\s*<\/h3>[\s\S]{0,250}?<p[^>]*class=["'][^"']*ooa-15sm3kk[^"']*["'][^>]*>\s*(PLN|zł)\s*<\/p>/i);
        if (strictHtmlMatch) {
          priceValueText = String(strictHtmlMatch[1] || '').replace(/ /g, ' ').trim();
          priceCurrencyText = strictHtmlMatch[2] || 'PLN';
        }

        if (!priceValueText) {
          const priceSelectors = [
            ".ooa-rz87wg h3.ooa-3ewd90",
            "h3.ooa-3ewd90",
            "[data-testid='ad-price-container'] h3",
            "[class*='price'] h3",
          ];
          for (const sel of priceSelectors) {
            const nodes = Array.from(card.querySelectorAll(sel));
            for (const el of nodes) {
              const t = txt(el);
              if (/^\d{2,3}(?:[\s ]\d{3})*$/.test(t)) {
                priceValueText = t;
                break;
              }
            }
            if (priceValueText) break;
          }
        }
        if (!priceCurrencyText) {
          const priceCurrencyEl = card.querySelector(".ooa-rz87wg .ooa-15sm3kk, .ooa-15sm3kk, [aria-label*='PLN'], [aria-label*='zł']");
          priceCurrencyText = priceCurrencyEl ? (priceCurrencyEl.getAttribute('aria-label') || txt(priceCurrencyEl)) : "PLN";
        }

        const priceDigits = priceValueText ? Number(String(priceValueText).replace(/[^\d]/g, '')) : null;
        const strictPriceText = priceDigits ? `${priceValueText} PLN` : "";
        const priceText = strictPriceText || rawText;
        const priceEur = priceDigits ? Math.round(priceDigits * plnToEur) : null;

        return { url: absoluteUrl, title: titleText || txt(a), raw: rawText, year, priceText, priceEur, priceDigits, priceSource: priceDigits ? 'otomoto-card-strict' : 'otomoto-fallback', modelSlugFromUrl };
      }

      const container = a.closest("article, li, section, div[class*='offer'], div[data-testid], tr") || a;
      return { url: absoluteUrl, title: txt(a), raw: txt(container) };
    }

    const out = [];
    const seenUrls = new Set();
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!keepHref(href)) continue;
      let absoluteUrl;
      try { absoluteUrl = new URL(href, searchUrl).toString(); } catch { continue; }
      if (seenUrls.has(absoluteUrl)) continue;
      seenUrls.add(absoluteUrl);
      const listing = extractListing(a, absoluteUrl);
      if (!listing.raw || listing.raw.length < 20) continue;
      listing.__debugHrefs = debugHrefs;
      out.push(listing);
    }
    if (out.length === 0) out.push({ __noMatch: true, __debugHrefs: debugHrefs });
    return out;
  }, { country, searchUrl, debugHrefs, plnToEur: PLN_TO_EUR });
}

async function scrapeCountry(browser, country, filters, emit){
  const sourceName = SOURCES[country].name;
  emit && emit("progress", `${sourceName}: opening browser context…`);

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: country === "PL" ? "pl-PL" : country === "DE" ? "de-DE" : "en-US",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": country === "PL" ? "pl-PL,pl;q=0.9,en;q=0.8" : country === "DE" ? "de-DE,de;q=0.9,en;q=0.8" : "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    }
  });
  let page = await context.newPage();

  // Mask headless browser signals to avoid bot detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) route.abort();
    else route.continue();
  });

  const maxPages = Math.max(1, Number(filters.model ? Math.max(Number(filters.maxPages || 20), 50) : Number(filters.maxPages || 20)));
  let rawTotal = [];
  let pagesVisited = 0;

  try {
    for (let p = 1; p <= maxPages; p++) {
      const url = buildSearchUrl(country, filters, p);
      emit && emit("progress", `${sourceName}: scraping page ${p}… (${url})`);
      let rawPage;
      try {
        rawPage = await scrapeSinglePage(page, url, country);
      } catch (err) {
        if (country === 'PL' && /crash/i.test(String(err && err.message || ''))) {
          emit && emit("progress", `${sourceName}: page ${p} crashed, recreating page and continuing…`);
          try { await page.close(); } catch {}
          const newPage = await context.newPage();
          await newPage.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['pl-PL', 'pl', 'en-US', 'en'] });
            window.chrome = { runtime: {} };
          });
          await newPage.route("**/*", route => {
            const type = route.request().resourceType();
            if (["image", "font", "media"].includes(type)) route.abort();
            else route.continue();
          });
          rawPage = await scrapeSinglePage(newPage, url, country);
          page = newPage;
        } else {
          throw err;
        }
      }
      pagesVisited += 1;

      // Handle debug sentinel (no listings matched keepHref)
      const noMatch = rawPage.length === 1 && rawPage[0].__noMatch;
      const debugHrefs = noMatch
        ? rawPage[0].__debugHrefs
        : (rawPage[0] && rawPage[0].__debugHrefs) || [];

      // Strip sentinels and debug fields before processing
      const raw = noMatch ? [] : rawPage.map(r => { const {__debugHrefs, ...rest} = r; return rest; });

      if (!raw.length) {
        if (debugHrefs && debugHrefs.length) {
          emit && emit("progress", `${sourceName}: page ${p} — 0 listings matched. Sample hrefs: ${debugHrefs.slice(0, 6).join(" | ")}`);
          // If page looks like a bot block, stop early
          const ofertaCount = debugHrefs.filter(h => h.includes("/oferta/")).length;
          emit && emit("progress", `${sourceName}: page ${p} — /oferta/ links found in hrefs: ${ofertaCount}`);
        }
        break;
      }

      const existingUrls = new Set(rawTotal.map(x => x.url));
      const newItems = raw.filter(x => !existingUrls.has(x.url));

      emit && emit("progress", `${sourceName}: page ${p} — ${raw.length} raw found, ${newItems.length} new unique`);

      if (p > 1 && newItems.length === 0) {
        emit && emit("progress", `${sourceName}: no new listings on page ${p} — end of results.`);
        break;
      }

      rawTotal.push(...newItems);
    }

    emit && emit("progress", `${sourceName}: normalising ${rawTotal.length} raw listings…`);

    const normalized = rawTotal.map(x => normalizeListing(x, sourceName, filters, country));
    // Log first 5 listings so we can verify price extraction
    for (const item of normalized.slice(0, 5)) {
      emit && emit("progress", `${sourceName} sample: model=${item.model} year=${item.year} km=${item.mileage} price=€${item.priceEur} priceText="${item.priceText}" url=...${item.url.slice(-40)}`);
    }

    let cleaned = dedupe(normalized)
      .filter(x => x.url && x.priceEur && x.priceEur >= 1500 && x.priceEur <= 200000);

    const beforeDamageFilter = cleaned.length;
    cleaned = cleaned.filter(x => !isDamagedListing(x));
    const damagedRemoved = beforeDamageFilter - cleaned.length;
    if (damagedRemoved > 0) {
      emit && emit("progress", `${sourceName}: removed ${damagedRemoved} damaged / crashed / broken listings.`);
    }

    if (filters.make) {
      cleaned = cleaned.filter(x => x.raw.toLowerCase().includes(filters.make.toLowerCase()) || norm(x.title).includes(norm(filters.make)));
    }
    if (filters.model) {
      const requestedModel = norm(filters.model);
      cleaned = cleaned.filter(x => {
        const modelNorm = norm(x.model);
        const titleNorm = norm(x.title);
        const rawNorm = norm(x.raw);
        if (modelNorm === requestedModel) return true;
        const exactToken = new RegExp(`(^|[^a-z0-9])${requestedModel.replace(/[-/\^$*+?.()|[\]{}]/g, '\$&')}(?![a-z0-9])`, 'i');
        return exactToken.test(titleNorm) || exactToken.test(rawNorm);
      });
    }

    const final = cleaned.filter(x => matchFilters(x, filters));

    emit && emit("progress", `${sourceName}: done — ${final.length} valid listings (${pagesVisited} pages).`);

    await context.close();
    return { listings: final, debug: { pagesVisited, rawFound: rawTotal.length, validListings: final.length }, sourceName };
  } catch (err) {
    emit && emit("progress", `${sourceName}: ERROR — ${err.message}`);
    await context.close();
    return { listings: [], debug: { pagesVisited, rawFound: rawTotal.length, validListings: 0 }, sourceName, error: `${sourceName}: ${err.message}` };
  }
}



async function inspectGeneratedSearchUrl(browser, country, url, emit, expected = {}){
  if (!url) return { ok: false, articleCount: 0, totalCount: null, pricesEur: [] };
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: country === "PL" ? "pl-PL" : country === "DE" ? "de-DE" : "en-US",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  async function extractInfoFromCurrentPage(){
    return await page.evaluate(({ country, plnToEur, expected }) => {
      const bodyText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const noExact = /No exact matches found/i.test(bodyText)
        || /Nie znaleziono dokładnych dopasowań/i.test(bodyText)
        || /Nie znaleziono dokładnego dopasowania/i.test(bodyText)
        || /slightly adjusted the price, year and\/or mileage criteria/i.test(bodyText)
        || /nieznacznie dostosowali(?:śmy)? kryteria ceny, roku i\/lub przebiegu/i.test(bodyText)
        || /dostosowali(?:śmy)? kryteria ceny, roku i\/lub przebiegu/i.test(bodyText);
      const emptyLt = country === 'LT' && /Nieko neradome|Skelbimų nerasta|0 skelb/i.test(bodyText);

      const pricesEur = [];
      const listingUrls = [];
      let articleCount = 0;
      let totalCount = null;

      if (country === 'PL') {
        const totalText = Array.from(document.querySelectorAll('p, h1, h2, h3, span'))
          .map(el => (el.innerText || '').trim())
          .find(t => /^\d+[\s ]*(ogłoszenie|ogłoszenia|ogłoszeń)$/i.test(t));
        if (totalText) {
          const m = totalText.match(/(\d+)/);
          if (m) totalCount = Number(m[1]);
        }

        const articles = Array.from(document.querySelectorAll('article[data-id]'));
        articleCount = articles.length;
        for (const card of articles) {
          const hrefEl = card.querySelector("a[href*='/oferta/']");
          const href = hrefEl ? (hrefEl.href || hrefEl.getAttribute('href') || '') : '';
          if (href) listingUrls.push(href);
          const priceH3 = card.querySelector('.ooa-rz87wg h3.ooa-3ewd90, h3.ooa-3ewd90');
          const currencyEl = card.querySelector('.ooa-rz87wg .ooa-15sm3kk, .ooa-15sm3kk');
          const valueText = priceH3 ? (priceH3.innerText || '').trim() : '';
          const currencyText = currencyEl ? ((currencyEl.innerText || '').trim()) : 'PLN';
          const digits = valueText ? Number(String(valueText).replace(/[^\d]/g, '')) : null;
          if (digits && /PLN|zł/i.test(currencyText || 'PLN')) pricesEur.push(Math.round(digits * plnToEur));
        }
      } else if (country === 'LT') {
        const countCandidates = [];
        const pushCountText = (t) => {
          const s = String(t || '').trim();
          if (s) countCandidates.push(s);
        };
        pushCountText(document.querySelector('.search-list-title span.result-count')?.innerText);
        pushCountText(document.querySelector('h1 span.result-count')?.innerText);
        pushCountText(document.querySelector('span.result-count')?.innerText);
        const defectLabel = Array.from(document.querySelectorAll('label, a, span, li'))
          .find(el => /Be defektų/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()));
        if (defectLabel) {
          const item = defectLabel.closest('label, a, li, .option-title, .item-title') || defectLabel;
          pushCountText(item.querySelector('.count-result')?.innerText);
          pushCountText(item.innerText);
        }
        const usedLabel = Array.from(document.querySelectorAll('label, a, span, li'))
          .find(el => /Naudoti/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()));
        if (usedLabel) {
          const item = usedLabel.closest('label, a, li, .option-title, .title-content') || usedLabel;
          pushCountText(item.querySelector('.count-result')?.innerText);
          pushCountText(item.innerText);
        }
        for (const txt of countCandidates) {
          const m = txt.match(/(\d+)/);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n)) {
              if (totalCount == null || n < totalCount) totalCount = n;
            }
          }
        }
        const anchors = Array.from(document.querySelectorAll("a[href*='/skelbimai/']"));
        const seen = new Set();
        const modelNeed = String(expected && expected.model || '').trim().toUpperCase();
        const yearNeed = Number(expected && expected.year || 0) || null;
        const makeNeed = String(expected && expected.make || '').trim().toUpperCase();
        const familyNeed = (function(){
          if (makeNeed === 'BMW' && /^\d{3}[A-Z]?$/i.test(modelNeed)) {
            const n = modelNeed.slice(0,1);
            return 'BMW ' + n;
          }
          return '';
        })();
        function matchesExpected(rawText){
          const txt = String(rawText || '').toUpperCase().replace(/\s+/g, ' ');
          if (!modelNeed) return true;
          if (yearNeed && !txt.includes(String(yearNeed))) return false;
          if (makeNeed && !txt.includes(makeNeed)) return false;
          if (makeNeed === 'BMW' && /^\d{3}[A-Z]?$/i.test(modelNeed)) {
            if (!new RegExp('\b' + modelNeed + '(?:[A-Z]{0,3})?\b', 'i').test(txt)) return false;
            const otherNums = txt.match(/(\d{3})(?:[A-Z]{0,3})?/g) || [];
            const wrong = otherNums.some(token => {
              const digits = String(token).replace(/[^\d]/g, '');
              return digits && digits !== modelNeed && ['316','318','320','323','325','328','330','335','340','418','420','428','430','435','440','518','520','523','525','528','530','535','540','545','550'].includes(digits);
            });
            if (wrong && !txt.includes(modelNeed + 'I') && !txt.includes(modelNeed + 'D')) return false;
            if (familyNeed && !txt.includes(familyNeed)) return false;
            return true;
          }
          return txt.includes(modelNeed);
        }
        for (const a of anchors) {
          const href = a.href || a.getAttribute('href') || '';
          if (!href || seen.has(href)) continue;
          const card = a.closest('li.announcement-item, .announcement-item, article, li, .announcement') || a;
          const rawCard = (card.innerText || '').trim();
          const rawHref = href.replace(/[-_/]/g, ' ');
          if (!matchesExpected(rawCard + ' ' + rawHref)) continue;
          const priceSelectors = [
            '.announcement-item-price',
            '.announcement-price',
            '.price-value',
            "[data-testid='price']",
            "[data-testid*='price-value']",
          ];
          let best = 0;
          for (const sel of priceSelectors) {
            const nodes = Array.from(card.querySelectorAll(sel));
            for (const el of nodes) {
              const t = (el.innerText || '').trim();
              const m = t.match(/(\d{1,3}(?:[\s.,]\d{3})*|\d+)\s*(€|EUR)/i);
              const v = m ? Number(String(m[1]).replace(/[^\d]/g, '')) : 0;
              if (v > best) best = v;
            }
          }
          if (!best) {
            const hits = rawCard.match(/\d{1,3}(?:[\s.,]\d{3})*\s*(?:€|EUR)/gi) || [];
            for (const hit of hits) {
              const v = Number(String(hit).replace(/[^\d]/g, ''));
              if (v > best) best = v;
            }
          }
          if (best) {
            seen.add(href);
            listingUrls.push(href);
            pricesEur.push(best);
          }
        }
        articleCount = listingUrls.length;
      } else {
        articleCount = document.querySelectorAll("article[data-id], article a[href*='/oferta/']").length;
      }

      return { noExact, emptyLt, articleCount, totalCount, pricesEur, listingUrls };
    }, { country, plnToEur: PLN_TO_EUR, expected });
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(country === 'PL' ? 2500 : 1500);
    if (country === 'PL') {
      await acceptCookiesIfPresent(page);
      await page.waitForTimeout(1500);
    }
    let info = await extractInfoFromCurrentPage();

    if (country === 'LT' && info.articleCount > 0 && !info.emptyLt) {
      const allPrices = [...info.pricesEur];
      const seenUrls = new Set(info.listingUrls || []);
      const targetCount = Number(info.totalCount || 0) || null;
      let pagesVisited = 1;
      const maxExtraPages = 14;
      for (let pno = 2; pno <= maxExtraPages + 1; pno++) {
        if (targetCount && seenUrls.size >= targetCount) break;
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('page_nr', String(pno));
        try {
          await page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1200);
          const pageInfo = await extractInfoFromCurrentPage();
          if (pageInfo.emptyLt || pageInfo.articleCount === 0) break;
          let newOnPage = 0;
          (pageInfo.listingUrls || []).forEach((href, idx) => {
            if (href && !seenUrls.has(href)) {
              seenUrls.add(href);
              const price = (pageInfo.pricesEur || [])[idx];
              if (price) allPrices.push(price);
              newOnPage += 1;
            }
          });
          pagesVisited += 1;
          if (newOnPage === 0) break;
        } catch {
          break;
        }
      }
      info.pricesEur = allPrices.filter(Boolean);
      const cappedCount = targetCount ? Math.min(targetCount, seenUrls.size || targetCount) : (seenUrls.size || info.articleCount);
      info.articleCount = cappedCount || info.articleCount;
      info.totalCount = targetCount || info.totalCount || seenUrls.size;
      if (targetCount && info.pricesEur.length > targetCount) {
        info.pricesEur = info.pricesEur.slice(0, targetCount);
      }
      if (emit) emit('progress', `Autoplius live override scanned ${pagesVisited} page(s), ${info.articleCount} listing(s).`);
    }

    return { ok: info.articleCount > 0 && !info.noExact && !info.emptyLt, ...info };
  } catch (err) {
    emit && emit('progress', `${SOURCES[country]?.name || country}: generated link validation failed — ${err.message}`);
    return { ok: false, articleCount: 0, totalCount: null, pricesEur: [] };
  } finally {
    await context.close();
  }
}

async function validateGeneratedSearchUrl(browser, country, url, emit){
  const info = await inspectGeneratedSearchUrl(browser, country, url, emit);
  return info.ok;
}

async function compareByMake(filters, emit){
  emit && emit("progress", "Launching browser…");
  const browser = await chromium.launch({ headless: true });
  const speedMode = String(filters.speedMode || 'strict').toLowerCase();
  // Live result-page price rechecks removed by request.
  // Keep discovered scrape data only for faster results.
  const verifyLimit = 0;
  const minListings = Math.max(1, Number(filters.minListings || 1));
  const blacklist = new Set(Array.isArray(filters.blacklist) ? filters.blacklist.map(x=>String(x)) : []);
  try {
    emit && emit("progress", `Scraping ${COUNTRY_NAMES[filters.buyCountry]} (buy side)…`);
    const buySide  = await scrapeCountry(browser, filters.buyCountry,  filters, emit);

    emit && emit("progress", `Scraping ${COUNTRY_NAMES[filters.sellCountry]} (sell side)…`);
    const sellSide = await scrapeCountry(browser, filters.sellCountry, filters, emit);

    emit && emit("progress", "Grouping by model and computing averages…");

    const buyListings  = buySide.listings;
    const sellListings = sellSide.listings;

    const buyStats  = { sampleSize: buyListings.length,  averagePrice: Math.round(avg(buyListings.map(x=>x.priceEur)))  };
    const sellStats = { sampleSize: sellListings.length, averagePrice: Math.round(avg(sellListings.map(x=>x.priceEur))) };

    // Group by model + year first, then narrow each match to a shared mileage bracket.
    // This keeps good coverage while making the compared cars much closer in mileage.
    const currentYear = new Date().getFullYear();
    const buyByKey  = new Map();
    const sellByKey = new Map();
    const buildSpecKey = (item) => {
      const yr = (item.year && item.year >= 1985 && item.year <= currentYear + 1) ? item.year : null;
      const fuel = item.fuel || '?';
      const gearbox = item.gearbox || '?';
      return `${item.model||"Unknown"}||${yr||"?"}||${fuel}||${gearbox}`;
    };
    for (const item of buyListings) {
      const key = buildSpecKey(item);
      if (!buyByKey.has(key)) buyByKey.set(key, []);
      buyByKey.get(key).push(item);
    }
    for (const item of sellListings) {
      const key = buildSpecKey(item);
      if (!sellByKey.has(key)) sellByKey.set(key, []);
      sellByKey.get(key).push(item);
    }

    const models = [];
    for (const [key, buyGroupAll] of buyByKey.entries()) {
      const sellGroupAll = sellByKey.get(key);
      const [model, yearStr, fuelStr, gearboxStr] = key.split("||");
      if (!sellGroupAll || !sellGroupAll.length) continue;

      const repYr  = yearStr !== "?" ? Number(yearStr) : null;
      const repBrk = pickSharedMileageBracket(buyGroupAll, sellGroupAll);
      const buyGroup  = filterGroupToMileageBracket(buyGroupAll, repBrk);
      const sellGroup = filterGroupToMileageBracket(sellGroupAll, repBrk);

      const finalBuyGroup  = buyGroup.length  ? buyGroup  : buyGroupAll;
      const finalSellGroup = sellGroup.length ? sellGroup : sellGroupAll;
      if (finalBuyGroup.length + finalSellGroup.length < 2) continue;

      const buyAverage  = Math.round(avg(finalBuyGroup.map(x=>x.priceEur)));
      const sellAverage = Math.round(avg(finalSellGroup.map(x=>x.priceEur)));
      const difference  = sellAverage - buyAverage;

      const combined       = [...finalBuyGroup, ...finalSellGroup];
      const buyStats2      = deriveGroupStats(finalBuyGroup);
      const sellStats2     = deriveGroupStats(finalSellGroup);
      const repFuel        = (buyStats2.fuel || sellStats2.fuel || (fuelStr !== '?' ? fuelStr : null));
      const repGearbox     = (buyStats2.gearbox || sellStats2.gearbox || (gearboxStr !== '?' ? gearboxStr : null));
      const mileageSummary = median(combined.map(x=>x.mileage).filter(Boolean));
      const sharedMileage  = mileageSummary || buyStats2.mileageMedian || sellStats2.mileageMedian;

      const buyUrl  = buildModelSearchUrl(filters.buyCountry,  filters, model, repYr, repBrk, sharedMileage, repFuel, repGearbox);
      const sellUrl = buildModelSearchUrl(filters.sellCountry, filters, model, repYr, repBrk, sharedMileage, repFuel, repGearbox);
      emit && emit("progress", `Match [${model} ${repYr || "?"} ${repFuel || ''} ${repGearbox || ''}] mileage=${repBrk || "unfiltered"} buy=${finalBuyGroup.length}/${buyGroupAll.length} sell=${finalSellGroup.length}/${sellGroupAll.length}`);

      models.push({
        model,
        usedFamilyFallback: false,
        buyAverage,
        sellAverage,
        difference,
        buyCount:   finalBuyGroup.length,
        sellCount:  finalSellGroup.length,
        repYear:    repYr,
        repFuel,
        repGearbox,
        repMileage: mileageSummary,
        repBracket: repBrk,
        buySearchUrl:  buyUrl,
        sellSearchUrl: sellUrl,
      });
    }

    models.sort((a,b) => b.difference - a.difference);

    const validatedModels = [];
    for (const [rowIndex, row] of models.entries()) {
      row.liveVerifiedBuy = false;
      row.liveVerifiedSell = false;
      row.liveVerified = false;
      const shouldVerify = rowIndex < verifyLimit;
      let keep = true;
      if (shouldVerify && filters.buyCountry === 'PL' && row.buySearchUrl) {
        const info = await inspectGeneratedSearchUrl(browser, 'PL', row.buySearchUrl, emit, { model: row.model, year: row.repYear, make: filters.make });
        if (!info.ok) {
          emit && emit('progress', `Removed ${row.model} ${row.repYear || ''} — Otomoto buy link auto-adjusted filters or had no exact matches.`);
          keep = false;
        } else if (info.pricesEur && info.pricesEur.length) {
          row.buyAverage = Math.round(avg(info.pricesEur));
          row.buyCount = info.totalCount || info.articleCount || info.pricesEur.length;
          row.difference = row.sellAverage - row.buyAverage;
          row.liveVerifiedBuy = true;
          emit && emit('progress', `Adjusted ${row.model} ${row.repYear || ''} buy side from live Otomoto link: ${row.buyCount} listings, avg €${row.buyAverage}.`);
        }
      }
      if (keep && shouldVerify && filters.sellCountry === 'PL' && row.sellSearchUrl) {
        const info = await inspectGeneratedSearchUrl(browser, 'PL', row.sellSearchUrl, emit, { model: row.model, year: row.repYear, make: filters.make });
        if (!info.ok) {
          emit && emit('progress', `Removed ${row.model} ${row.repYear || ''} — Otomoto sell link auto-adjusted filters or had no exact matches.`);
          keep = false;
        } else if (info.pricesEur && info.pricesEur.length) {
          row.sellAverage = Math.round(avg(info.pricesEur));
          row.sellCount = info.totalCount || info.articleCount || info.pricesEur.length;
          row.difference = row.sellAverage - row.buyAverage;
          row.liveVerifiedSell = true;
          emit && emit('progress', `Adjusted ${row.model} ${row.repYear || ''} sell side from live Otomoto link: ${row.sellCount} listings, avg €${row.sellAverage}.`);
        }
      }
      if (keep && shouldVerify && filters.buyCountry === 'LT' && row.buySearchUrl) {
        const info = await inspectGeneratedSearchUrl(browser, 'LT', row.buySearchUrl, emit, { model: row.model, year: row.repYear, make: filters.make });
        if (info.ok && info.pricesEur && info.pricesEur.length) {
          row.buyAverage = Math.round(avg(info.pricesEur));
          row.buyCount = info.totalCount || info.articleCount || info.pricesEur.length;
          row.difference = row.sellAverage - row.buyAverage;
          row.liveVerifiedBuy = true;
          emit && emit('progress', `Adjusted ${row.model} ${row.repYear || ''} buy side from live Autoplius link: ${row.buyCount} listings, avg €${row.buyAverage}.`);
        }
      }
      if (keep && shouldVerify && filters.sellCountry === 'LT' && row.sellSearchUrl) {
        const info = await inspectGeneratedSearchUrl(browser, 'LT', row.sellSearchUrl, emit, { model: row.model, year: row.repYear, make: filters.make });
        if (info.ok && info.pricesEur && info.pricesEur.length) {
          row.sellAverage = Math.round(avg(info.pricesEur));
          row.sellCount = info.totalCount || info.articleCount || info.pricesEur.length;
          row.difference = row.sellAverage - row.buyAverage;
          row.liveVerifiedSell = true;
          emit && emit('progress', `Adjusted ${row.model} ${row.repYear || ''} sell side from live Autoplius link: ${row.sellCount} listings, avg €${row.sellAverage}.`);
        }
      }
      // Autoplius result pages are more sensitive to query/model_id combinations, so rows are
      // not pruned just because the generated LT link looks empty. But when the page is valid,
      // the live LT result page now overrides the sampled count and average just like Otomoto.
      row.liveVerified = !!(row.liveVerifiedBuy && row.liveVerifiedSell);
      if (keep) validatedModels.push(row);
    }
    let finalModels = validatedModels.length ? validatedModels : models;
    if (!validatedModels.length && models.length) {
      emit && emit('progress', 'Validation removed every row, so the app kept the sampled matches instead of returning an empty result.');
    }

    finalModels = finalModels.filter(row => Number.isFinite(row.difference) && row.difference > 0 && Math.min(Number(row.buyCount||0), Number(row.sellCount||0)) >= minListings && !blacklist.has(`${row.model}|${row.repYear||''}|${row.repFuel||''}|${row.repGearbox||''}`));
    finalModels.sort((a,b) => b.difference - a.difference || b.sellAverage - a.buyAverage);

    for (const row of finalModels) {
      let confidence = 40;
      if (row.repYear) confidence += 10;
      if (row.repFuel) confidence += 10;
      if (row.repGearbox) confidence += 10;
      if (row.repMileage) confidence += 10;
      confidence += Math.min(10, Math.min(Number(row.buyCount||0), Number(row.sellCount||0)) * 2);
      if (row.liveVerifiedBuy) confidence += 5;
      if (row.liveVerifiedSell) confidence += 5;
      row.confidence = Math.max(0, Math.min(100, confidence));
      row.rowKey = `${row.model}|${row.repYear||''}|${row.repFuel||''}|${row.repGearbox||''}`;
    }

    const errors = [buySide.error, sellSide.error].filter(Boolean);
    const statusMsg = errors.length
      ? `Buy: ${buyStats.sampleSize} listings, Sell: ${sellStats.sampleSize} listings. Errors: ${errors.join("; ")}`
      : `Buy: ${buyStats.sampleSize} listings from ${COUNTRY_NAMES[filters.buyCountry]}. Sell: ${sellStats.sampleSize} listings from ${COUNTRY_NAMES[filters.sellCountry]}.`;

    emit && emit("progress", "Complete!");

    return {
      status: statusMsg,
      buyStats, sellStats,
      buyListingCount:  buyListings.length,
      sellListingCount: sellListings.length,
      buyDebug:  buySide.debug,
      sellDebug: sellSide.debug,
      models: finalModels,
      errors
    };
  } finally {
    await browser.close();
  }
}

module.exports = { compareByMake };