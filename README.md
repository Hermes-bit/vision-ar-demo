# Vision AR — démonstration

Guidage piéton accessible (fauteuil roulant, canne, malvoyance, malentendance),
démonstration sur **Gennevilliers**. L'itinéraire tient compte de l'effort réel :
pentes, marches, bordures de trottoir, feux sonores, revêtement.

**Ouvrir la démo : https://hermes-bit.github.io/vision-ar-demo/**

## Sur le téléphone

L'appli s'ouvre sur **Bienvenue**, puis **Connexion** ou **Inscription** (Geomessen Burkina Faso).
En mode démonstration, le compte est enregistré uniquement sur le téléphone (mot de passe chiffré,
rien n'est envoyé) ; les boutons Google et Apple seront actifs avec de vrais comptes.

1. Ouvrir le lien ci-dessus dans Chrome (Android) ou Safari (iPhone).
2. L'installer sur l'écran d'accueil :
   - Android : menu ⋮ → « Ajouter à l'écran d'accueil » (ou le bouton « Installer » de l'appli) ;
   - iPhone : bouton Partager → « Sur l'écran d'accueil ».
3. Choisir son profil et son **thème** (Verre : clair, ruban lumineux ; Néon : sombre, repères flottants),
   une destination, puis « Démarrer le guidage ».
4. Le guidage s'affiche **dans la caméra** : itinéraire dessiné au sol (ruban et chevrons), bulle de
   consigne accrochée au prochain virage, repères des obstacles, bordures abaissées, marches, ascenseurs,
   toilettes adaptées… En haut : marches, heure d'arrivée, distance. En bas : mini-carte en dôme avec
   boussole, et la barre de commandes :
   - ⚙ réglages : état de la position en clair (« Position précise, à 4 m près »), **Recalculer
     l'itinéraire**, **vibrations de direction**, thème, arrêt ;
   - **Plan** : agrandit la carte ; bouton central : **signaler un obstacle** ; **Lunettes** : vue des
     lunettes connectées ; 🔊 : voix.
   Les repères viennent des données, pas d'une reconnaissance d'image : précision de quelques mètres.
   Le guidage suit le **GPS** (sur place, à Gennevilliers). Le dessin est calé sur la boussole, l'inclinaison
   du téléphone et sa hauteur (debout ou en fauteuil). Si l'on s'écarte de l'itinéraire ou si l'on prend
   une mauvaise rue, un nouvel itinéraire est calculé automatiquement ; en sens inverse, l'appli dit
   « faites demi-tour ».
   **Vibrations** : 2 impulsions = à gauche, 3 = à droite, 5 rapides = mauvais sens, 1 longue = arrivé
   (Android ; sur iPhone, Safari ne donne pas accès au vibreur : de petits « tics » sont tentés).
5. **Gestes** : glisser depuis le **bord gauche** vers la droite pour revenir en arrière, depuis le
   **bord droit** vers la gauche pour avancer (profil → recherche → démarrer le guidage). Quitter un
   guidage par geste demande une confirmation. Le choix d'itinéraire a un bouton « Fermer » sur le plan
   et dans la liste.

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
- Police : [Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/) du Braille Institute, conçue pour
  les personnes malvoyantes (licence SIL OFL, `fonts/OFL.txt`).
- Icônes : [Lucide](https://lucide.dev) (licence ISC, `js/LICENSE-lucide.txt`) et pictogrammes dessinés pour
  Vision AR (fauteuil, canne, ascenseur, WC…).

- Photo de l'écran de connexion et logo : fournis par Geomessen Burkina Faso.

Projet Vision AR — Geomessen Burkina Faso.
