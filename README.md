# Vision AR — démonstration

Guidage piéton accessible (fauteuil roulant, canne, malvoyance, malentendance),
démonstration sur **Gennevilliers**. L'itinéraire tient compte de l'effort réel :
pentes, marches, bordures de trottoir, feux sonores, revêtement.

**Ouvrir la démo : https://hermes-bit.github.io/vision-ar-demo/**

## Sur le téléphone

1. Ouvrir le lien ci-dessus dans Chrome (Android) ou Safari (iPhone).
2. L'installer sur l'écran d'accueil :
   - Android : menu ⋮ → « Ajouter à l'écran d'accueil » (ou le bouton « Installer » de l'appli) ;
   - iPhone : bouton Partager → « Sur l'écran d'accueil ».
3. Choisir son profil, une destination, puis « Démarrer le guidage » :
   - **Simulation** : la position avance seule le long de l'itinéraire (×1, ×5, ×20) ;
   - **GPS réel** : sur place à Gennevilliers, les consignes suivent votre position
     et l'itinéraire est recalculé si vous vous en écartez.
4. 👓 affiche la vue des lunettes connectées ; 🔊 coupe ou active la voix.

Tout fonctionne sur le téléphone, même hors ligne une fois ouvert (sauf la
recherche d'adresse et le fond de carte non encore vu). Les signalements
d'obstacles restent sur votre téléphone dans cette démo.

## Comment c'est fait

- `js/routing.js` : moteur d'itinéraire, traduction fidèle du serveur Python de
  Vision AR. Un test automatique vérifie que les deux donnent exactement les
  mêmes résultats sur le réseau de Gennevilliers.
- `data/gennevilliers.json` : réseau piéton (8 798 tronçons) exporté de la base
  PostGIS du projet.

## Sources et licences

- Réseau piéton et équipements : © les contributeurs d'[OpenStreetMap](https://www.openstreetmap.org/copyright),
  sous licence [ODbL](https://opendatacommons.org/licenses/odbl/) ; le fichier
  `data/gennevilliers.json` est une base de données dérivée, sous la même licence.
- Pentes : calculées à partir du relief RGE ALTI © IGN (Géoplateforme).
- Recherche d'adresse : service de géocodage de l'IGN (Géoplateforme).
- Fond de carte : tuiles © OpenStreetMap.
- Carte interactive : [Leaflet](https://leafletjs.com) 1.9.4 (licence BSD-2).

Projet GeoVision AR.
