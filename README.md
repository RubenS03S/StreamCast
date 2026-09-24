# StreamCast

Partage d'écran en direct du PC de Ruben vers un iPad ou un iPhone : un lien ou un code à 3 chiffres (4 en option), l'image et le son en 60 FPS jusqu'en 4K, le micro dans les deux sens, un chat, et un mini‑lecteur pour garder le live en regardant autre chose.

La vidéo et le son passent **directement** du PC à l'iPad (WebRTC, pair‑à‑pair). Le serveur ne sert qu'à se retrouver avec le code : il ne voit jamais passer l'image.

## Utilisation

**Sur le PC (Ruben)**, dans Chrome ou Edge :

1. Clique **Télécharger sur PC** pour installer l'app (elle s'ouvre ensuite dans sa propre fenêtre, depuis le menu Démarrer).
2. Choisis la **version de diffusion** (Auto conseillé), active le **micro** si tu veux parler.
3. **Démarrer le live** → choisis **Écran entier** et coche **Partager l'audio du système**. Tout ce que tu fais est alors filmé en continu : jeu, Google, bureau… StreamCast te prévient si tu as choisi une seule fenêtre.
4. Envoie le lien avec **Copier le lien**, **Partager** ou le **QR code**. Le lien et le code restent les mêmes d'un live à l'autre.
5. **Mini-retour** ouvre une petite fenêtre toujours au‑dessus du jeu : ton écran, ce que voit réellement le spectateur, la qualité reçue, la latence, le micro et les messages.

**Sur l'iPad / l'iPhone** : ouvrir le lien suffit, la connexion est directe. Le son démarre à la première touche sur l'écran (règle d'Apple). Pour l'avoir comme une app : Safari → Partager → *Sur l'écran d'accueil* ; l'app se reconnecte alors toute seule au live de Ruben. Si le live n'a pas encore commencé, l'écran attend et se connecte dès que Ruben le lance.

## Fonctionnalités

- **Versions de diffusion** : Auto, 4K, 1440p, 1080p, 720p, 120 FPS, Netteté (texte), Éco (4G/5G), modifiables pendant le live.
- **Mode Auto** : vise 60 FPS constants. C'est le PC qui fait tout le travail : il encode, mesure en continu la connexion de l'iPad (pertes, gigue, images perdues) et envoie exactement ce qu'elle peut absorber. La résolution est limitée à ce que l'écran du spectateur peut afficher (1440p pour l'iPad), baisse d'un cran si le PC, le réseau ou l'iPad n'arrive plus à suivre, et remonte quand tout redevient fluide. Côté iPad, la latence *Auto* ajoute une petite marge quand le Wi‑Fi est instable.
- **Codec** : Auto (H.264 décodé en matériel sur iPad/iPhone, AV1 si l'appareil le décode en matériel, comme l'iPhone 17), ou forcé (H.264, AV1, H.265, VP9). Changement à chaud, sans couper le live.
- **Audio** : son du PC + voix de Ruben mixés en stéréo haute qualité ; micro du spectateur renvoyé vers le PC. Le spectateur règle séparément le volume du jeu et de la voix.
- **Lecteur** : plein écran (StreamCast ou lecteur iPad natif), mini‑lecteur (Picture‑in‑Picture), Ajuster / Remplir, zoom à deux doigts et double‑tap, statistiques (résolution, FPS, débit, latence), latence minimale ou fluide.
- **Retour du stream** : aperçu de la capture, vignette de ce que voit le spectateur (« Vue de Léa »), qualité de son réseau, et fenêtre **Mini‑retour** au‑dessus du jeu.
- **Chat et réactions**, liste des spectateurs avec qualité reçue, exclusion, validation des spectateurs (option), sons et notifications Windows.
- **Reconnexion automatique** si le réseau coupe ou si le live redémarre.

### Limites imposées par Apple

- Un navigateur sur iPad/iPhone ne peut pas capturer l'écran (réservé aux apps natives). Depuis l'iPad, StreamCast diffuse donc la **caméra**.
- iOS interdit à une page web de changer le volume d'une vidéo : les volumes *Jeu* / *Voix* du spectateur sont appliqués côté PC.

## Tester gratuitement en local

Aucun crédit Netlify n'est utilisé. Il faut [Node.js](https://nodejs.org) (version 22 ou plus) sur le PC.

- Windows : double‑clic sur `start-local.bat`
- ou : `node server/dev.mjs`

Ouvre `http://localhost:8888` sur le PC. L'adresse **Sur le Wi‑Fi** affichée dans la console s'ouvre sur l'iPad (même réseau Wi‑Fi). En local, le micro de l'iPad reste désactivé, car Safari l'exige sur une adresse en `https`. Tout le reste fonctionne.

## Mise en ligne (Netlify)

Le dossier est prêt pour Netlify : `public/` pour le site, `netlify/functions/signal.mts` pour la mise en relation (stockage Netlify Blobs, rien à configurer).

- Relier le dépôt GitHub à un nouveau site Netlify, ou `netlify deploy --prod`.
- Consommation : chaque déploiement compte ; ensuite, seules la mise en relation et une petite requête toutes les 2 à 4 secondes pendant un live passent par Netlify. La vidéo n'y passe jamais.

### Serveur relais (optionnel)

La connexion directe marche sur la grande majorité des réseaux. Pour les réseaux mobiles très fermés, un relais TURN peut être ajouté via les variables d'environnement Netlify :

- Cloudflare : `CF_TURN_KEY_ID` et `CF_TURN_API_TOKEN`
- ou n'importe quel serveur TURN : `TURN_URLS` (séparées par des virgules), `TURN_USERNAME`, `TURN_CREDENTIAL`

## Conseils pour la meilleure qualité

- PC en **Ethernet**, iPad en Wi‑Fi **5 GHz ou 6 GHz** près de la box.
- Chrome/Edge avec l'**accélération matérielle** activée : les stats du live indiquent *GPU* quand l'encodage passe par la carte graphique.
- Jeux en **plein écran fenêtré** (borderless) pour une capture fluide.
- Casque conseillé côté PC pour éviter l'écho.

## Structure

```
public/                  Application (HTML, CSS, JS sans build)
  js/host.js             Diffusion : capture, mixage audio, encodage, mode Auto
  js/viewer.js           Lecteur : connexion, plein écran, mini-lecteur, zoom, chat
  js/rtc.js              WebRTC : codecs, réglages SDP, statistiques
  js/api.js              Client de mise en relation
netlify/functions/       Fonction de mise en relation (Netlify)
netlify/lib/signal-core.mjs  Logique partagée (Netlify + serveur local)
server/dev.mjs           Serveur local
```
