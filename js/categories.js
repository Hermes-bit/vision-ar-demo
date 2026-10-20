// Catégories des établissements (Acceslibre) : l'activité déclarée -> une famille (couleur) et un pictogramme.
//
// Couleurs « typiques », proches de celles des grandes cartes (Google Maps, Plans) : orange pour manger, rouge
// pour la santé, vert « croix verte » pour les pharmacies, rose pour la beauté… Toutes assez foncées pour que
// le pictogramme blanc reste lisible (contraste ≥ 3:1). Le bleu des signalétiques PMR est réservé aux
// équipements d'accessibilité (entrées, toilettes, ascenseurs, places), le reste de la palette aux transports.
// Module sans dépendance au navigateur : testé par web/tests/categories.test.mjs.

export const CATEGORIES = {
  food:      {label: "Manger et alimentation", color: "#D9620B"},
  shop:      {label: "Commerces", color: "#8E24AA"},
  health:    {label: "Santé", color: "#D93025"},
  pharmacy:  {label: "Pharmacie", color: "#188038"},
  beauty:    {label: "Beauté et bien-être", color: "#D81B60"},
  lodging:   {label: "Hôtels", color: "#3F51B5"},
  education: {label: "Écoles et enfance", color: "#795548"},
  leisure:   {label: "Culture, loisirs et sport", color: "#00897B"},
  services:  {label: "Services", color: "#5F6368"},
  auto:      {label: "Automobile", color: "#455A64"},
};

const norm = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Dans l'ordre : la première règle qui correspond l'emporte (« Hôtel restaurant » est un hôtel, « Vente
// d'articles de sport » un commerce, « Auto école » une école de conduite…).
const RULES = [
  [/pharmacie|parapharmacie/, "pharmacy", "cross"],
  [/hotel|hebergement|residence hoteliere|auberge/, "lodging", "bed"],
  [/restauration rapide|fast.?food|snack|kebab|pizzeria/, "food", "sandwich"],
  [/cafe|bar\b|brasserie|salon de the/, "food", "coffee"],
  [/restaurant|traiteur|cantine/, "food", "utensils"],
  [/boulangerie|patisserie|viennoiserie/, "food", "croissant"],
  [/boucherie|viande|charcuterie|volaille|poissonnerie/, "food", "beef"],
  [/surgel/, "food", "snowflake"],
  [/supermarche|hypermarche|superette|epicerie|alimentation|primeur|marche/, "food", "shopping-cart"],
  [/hopital|clinique|urgences/, "health", "hospital"],
  [/dentiste|dentaire|orthodont/, "health", "smile"],
  [/laboratoire|analyse|radiologie|imagerie/, "health", "flask-conical"],
  [/psych/, "health", "brain"],
  [/ehpad|maison de retraite|personnes agees/, "health", "heart-handshake"],
  [/protection maternelle|\bpmi\b/, "health", "baby"],
  [/veterinaire/, "health", "paw-print"],
  [/medecin|generaliste|medical|sante|kine|infirmi|specialiste/, "health", "stethoscope"],
  [/opticien|optique/, "shop", "glasses"],
  [/coiff|barbier/, "beauty", "scissors"],
  [/esthetique|beaute|bien-etre|bien etre|spa\b|onglerie|massage/, "beauty", "sparkles"],
  [/auto.?ecole|ecole de conduite/, "education", "car"],
  [/universite|ecole superieure|enseignement superieur/, "education", "graduation-cap"],
  [/creche|garderie|halte|assistante maternelle/, "education", "baby"],
  [/ecole|college|lycee|enseignement|formation/, "education", "school"],
  [/carrosserie/, "auto", "car-front"],
  [/garage|automobile|controle technique|pneu|reparation auto|station.?service/, "auto", "wrench"],
  [/vente|magasin|boutique|articles de/, "shop", "shopping-bag"],
  [/bibliotheque|mediatheque/, "leisure", "book-open"],
  [/theatre|spectacle|opera|concert/, "leisure", "drama"],
  [/cinema/, "leisure", "clapperboard"],
  [/musee|centre culturel|culture|exposition|galerie/, "leisure", "palette"],
  [/salle des fetes|salle polyvalente|fetes/, "leisure", "party-popper"],
  [/piscine|aquatique|natation/, "leisure", "waves"],
  [/stade|terrain de sport/, "leisure", "trophy"],
  [/gymnase|sport|fitness|musculation|danse/, "leisure", "dumbbell"],
  [/loisirs|centre de vacances|colonie/, "leisure", "tent"],
  [/office de tourisme|tourisme/, "services", "map"],
  [/poste/, "services", "mail"],
  [/banque|caisse d'epargne|credit|assurance/, "services", "piggy-bank"],
  [/finances publiques|impots|tresor|mairie|hotel de ville|prefecture|administration|tribunal|caf\b|cpam/, "services", "landmark"],
  [/association|solidarite|social/, "services", "heart-handshake"],
  [/coworking|bureau|espace de travail/, "services", "laptop"],
  [/pompes funebres|funeraire|cimetiere/, "services", "flower-2"],
  [/fleuriste|jardinerie/, "shop", "flower-2"],
  [/droguerie|quincaillerie|bricolage/, "shop", "spray-can"],
  [/vetement|habillement|chaussure|mode|pret-a-porter/, "shop", "shirt"],
  [/electromenager|audio|video|informatique|telephon|multimedia/, "shop", "tv"],
  [/artisanat|artisan|art\b/, "shop", "palette"],
  [/photo/, "shop", "camera"],
  [/librairie|presse|papeterie|livre/, "shop", "book-open"],
  [/commerce|shopping|centre commercial/, "shop", "shopping-bag"],
];

/** Activité Acceslibre -> {key, label, color, icon} ; une activité inconnue devient un commerce générique. */
export function erpCategory(activity) {
  const a = norm(activity);
  for (const [re, key, icon] of RULES) if (re.test(a)) return {key, icon, ...CATEGORIES[key]};
  return {key: "shop", icon: "store", ...CATEGORIES.shop};
}

/** Accessibilité de l'entrée, d'après la fiche : "ok" (plain-pied), "steps" (marches), "" (inconnu). */
export function entranceAccess(f = {}) {
  if (f.entree_plain_pied || (f.entree_plain_pied === undefined && f.cheminement_ext_plain_pied)) return "ok";
  if (f.entree_plain_pied === false) return f.entree_marches_rampe === "fixe" || f.entree_ascenseur ? "ok" : "steps";
  return "";
}
