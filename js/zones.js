// Villes et quartiers couverts par Vision AR. Chaque zone a son réseau piéton (data/<zone>.json, exporté de la
// base et corrigé par server/scripts/enrich_web_network.py), ses arrêts de transport et son point de départ
// par défaut. Ajouter une zone : importer le réseau (server/scripts/import_osm.py), l'exporter, puis la déclarer ici.
export const ZONES = {
  gennevilliers: {
    country: "France", city: "Gennevilliers", area: "", name: "Gennevilliers",
    start: {label: "Mairie de Gennevilliers", lat: 48.925459, lon: 2.294045},
    data: "data/gennevilliers.json", transit: "data/transit.json",
    france: true,                     // recherche d'adresse IGN, fonds de carte IGN, pentes IGN
  },
  ouaga2000: {
    country: "Burkina Faso", city: "Ouagadougou", area: "Ouaga 2000", name: "Ouaga 2000",
    start: {label: "Centre commercial de Ouaga 2000", lat: 12.306139, lon: -1.527139},
    data: "data/ouaga2000.json", transit: "data/ouaga2000.transit.json",
    france: false,                    // recherche d'adresse Photon (OpenStreetMap) ; pentes à relever sur place
  },
};
export const zoneLabel = z => z.area ? `${z.city} · ${z.area}` : z.city;
