// Alertes à proximité : ce qui gêne ou ce qui aide, autour d'une position, AVANT de partir.
//
// Le filtrage suit le profil déjà utilisé par le moteur (routing.js) : une marche n'est
// signalée qu'à qui ne peut pas la monter, une traversée sans feu sonore qu'à qui en a besoin.
// Aucune invention : tout vient des champs du réseau (has_step, kerb_lowered, sound_signal,
// slope_pct, width_m) et des points d'intérêt (places PMR, entrées, toilettes, ascenseurs).
import {haversineM} from "./routing.js";

export const RAYON_M = 300;       // au-delà, ce n'est plus « à proximité » à pied
export const LIMITE = 5;          // une liste qu'un lecteur d'écran peut dire d'une traite

// Un type par ligne affichée : au plus une alerte de chaque sorte, la plus proche.
export const TYPES = {
  marche:        {label: "Marche",                    icone: "stairs",            genant: true},
  bordure:       {label: "Bordure non abaissée",      icone: "triangle-alert",    genant: true},
  sans_feu:      {label: "Traversée sans feu sonore", icone: "volume-x",          genant: true},
  pente:         {label: "Pente forte",               icone: "mountain",          genant: true},
  etroit:        {label: "Passage étroit",            icone: "narrow",            genant: true},
  entree:        {label: "Entrée accessible",         icone: "door-open",         genant: false},
  ascenseur:     {label: "Ascenseur",                 icone: "elevator",          genant: false},
  toilettes:     {label: "Toilettes adaptées",        icone: "toilet",            genant: false},
  place_pmr:     {label: "Place PMR",                 icone: "square-parking",    genant: false},
};
const POI_TYPES = {
  accessible_entrance: "entree", elevator: "ascenseur",
  accessible_toilet: "toilettes", disabled_parking: "place_pmr",
};
// Les deux seules mobilités en fauteuil (profiles.py) : il n'existe pas de valeur « wheelchair ».
const EN_FAUTEUIL = new Set(["manual_wheelchair", "electric_wheelchair"]);

// Distance au point le plus proche du tracé d'une arête (et non à son milieu).
function distanceAuTrace(shape, lat, lon) {
  let mini = Infinity, point = null;
  for (const [a, b] of shape || []) {
    const d = haversineM(lat, lon, a, b);
    if (d < mini) { mini = d; point = [a, b]; }
  }
  return {distance: mini, point};
}

// Ce qui gêne CE profil sur CETTE arête. Rien si le profil n'est pas concerné.
function geneSurArete(edge, profil) {
  if (edge.has_step && profil.steps_allowed === false) return "marche";
  if (edge.is_crossing && edge.kerb_lowered === false && profil.needs_lowered_kerb) return "bordure";
  if (edge.is_crossing && edge.sound_signal === false && profil.prefers_sound_signals) return "sans_feu";
  if (profil.max_slope_pct != null && edge.slope_pct != null
      && Math.abs(edge.slope_pct) > profil.max_slope_pct) return "pente";
  if (profil.min_width_m != null && edge.width_m != null
      && edge.width_m < profil.min_width_m) return "etroit";
  return null;
}

// Un point d'intérêt n'aide que s'il sert à ce profil.
function aideUtile(kind, profil) {
  const type = POI_TYPES[kind];
  if (!type) return null;
  if (type === "place_pmr" && !EN_FAUTEUIL.has(profil.mobility)) return null;
  return type;
}

/**
 * Alertes autour d'une position, les plus proches d'abord, une seule par type.
 * @param {object} net   réseau chargé par loadNetwork()
 * @param {{lat:number, lon:number}} pos
 * @param {{profil:object, rayon?:number, limite?:number}} options
 * @returns {Array<{type:string, label:string, icone:string, genant:boolean,
 *                  distance:number, lat:number, lon:number, nom:string}>}
 */
export function alertesAutour(net, pos, {profil, rayon = RAYON_M, limite = LIMITE} = {}) {
  if (!net || !pos || !profil) return [];
  const meilleure = new Map();                       // type -> candidat le plus proche
  const retenir = (type, distance, lat, lon, nom) => {
    if (distance > rayon) return;
    const ancien = meilleure.get(type);
    if (!ancien || distance < ancien.distance) {
      meilleure.set(type, {type, ...TYPES[type], distance, lat, lon, nom: nom || ""});
    }
  };

  for (const edge of net.edges || []) {
    const type = geneSurArete(edge, profil);
    if (!type) continue;
    const {distance, point} = distanceAuTrace(edge.shape, pos.lat, pos.lon);
    if (point) retenir(type, distance, point[0], point[1], edge.name);
  }
  for (const [kind, lat, lon, nom] of net.pois || []) {
    const type = aideUtile(kind, profil);
    if (type) retenir(type, haversineM(pos.lat, pos.lon, lat, lon), lat, lon, nom);
  }

  return [...meilleure.values()].sort((a, b) => a.distance - b.distance).slice(0, limite);
}

// « Marche à 40 mètres, rue Gisèle Halimi » : une phrase que la voix peut dire telle quelle.
export function phraseAlerte(a) {
  const m = Math.round(a.distance / 5) * 5;          // au pas de 5 m : la précision au mètre est fausse
  return `${a.label} à ${m} m${a.nom ? `, ${a.nom}` : ""}`;
}
