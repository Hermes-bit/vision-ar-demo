// Fonctions activables. Retour terrain : le produit, c'est le guidage DEHORS, jusqu'à l'entrée accessible.
//
// indoorNavigationEnabled : navigation à l'intérieur des bâtiments (plans d'étage, js/indoor.js).
//   false : l'itinéraire s'arrête à l'entrée accessible, « Vous êtes arrivé à l'entrée » termine le guidage,
//   aucune donnée intérieure n'est chargée ni utilisée dans le calcul. Le code est conservé, pas supprimé :
//   passer à true remet le bouton « Plan intérieur » près des bâtiments qui ont un plan (data/indoor.json).
export const FEATURES = Object.freeze({
  indoorNavigationEnabled: false,
});
