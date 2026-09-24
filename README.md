# StreamCast

Partage d'écran en direct du PC de Ruben vers un iPad ou un iPhone, comme un appel : un lien (ou un code à 3 chiffres, 4 en option), l'image et le son du PC en 60 FPS jusqu'en 4K, et les deux micros ouverts pour se parler. Avec un chat, et un mini‑lecteur pour garder le live en regardant autre chose.

**Adresse : https://streamcast-ruben.netlify.app**

La vidéo et le son passent **directement** du PC à l'iPad (WebRTC, pair‑à‑pair). Le serveur ne sert qu'à se retrouver avec le code : il ne voit jamais passer l'image.

## Utilisation

**Sur le PC (Ruben)**, dans Chrome ou Edge :

1. Clique **Télécharger sur PC** pour installer l'app (elle s'ouvre ensuite dans sa propre fenêtre, depuis le menu Démarrer).
2. Choisis la **version de diffusion** (Auto conseillé). Le **micro** est activé par défaut, comme dans un appel.
3. **Démarrer le live** → choisis **Écran entier** et coche **Partager l'audio du système**. Tout ce que tu fais est alors filmé en continu : jeu, Google, bureau… StreamCast te prévient si tu as choisi une seule fenêtre.
4. Envoie le lien avec **Copier le lien**, **Partager** ou le **QR code**. Le lien et le code restent les mêmes d'un live à l'autre.
5. Le bloc **Retour** du tableau de bord montre ta capture et ce que voit réellement le spectateur ; **Masquer** le range. **Mini-retour** ouvre, uniquement quand tu le demandes, une petite fenêtre au‑dessus du jeu (écran, vue du spectateur, qualité, latence, qui parle, micro, messages) ; le même bouton la range.
6. La **vérification** sous les boutons confirme en direct : image capturée, écran entier, son du PC (avec niveau), micro, encodage par la carte graphique, anti‑écho. En cas d'écran noir ou saccadé, l'aide « Écran noir, figé ou saccadé ? » liste les réglages Windows et Chrome à vérifier.

**Sur l'iPad / l'iPhone** : ouvrir le lien suffit, la connexion est directe et le micro s'active pour l'appel (Safari demande l'autorisation la première fois ; réglable dans *Réglages › Appel*). Si le son ne démarre pas tout seul, une touche sur l'écran l'active (règle d'Apple). Pour l'avoir comme une app : Safari → Partager → *Sur l'écran d'accueil* ; l'app se reconnecte alors toute seule au live de Ruben. Si le live n'a pas encore commencé, l'écran attend et se connecte dès que Ruben le lance.

## Fonctionnalités

- **Versions de diffusion** : Auto, 4K, 1440p, 1080p, 720p, 120 FPS, Netteté (texte), Éco (4G/5G), modifiables pendant le live.
- **Mode Auto** : vise 60 FPS constants. C'est le PC qui fait tout le travail : il encode, mesure en continu la connexion de l'iPad (pertes, gigue, images perdues) et envoie exactement ce qu'elle peut absorber. La résolution est limitée à ce que l'écran du spectateur peut afficher (1440p pour l'iPad), baisse d'un cran si le PC, le réseau ou l'iPad n'arrive plus à suivre, et remonte quand tout redevient fluide. Côté iPad, la latence *Auto* ajoute une petite marge quand le Wi‑Fi est instable.
- **Codec** : Auto (H.264 décodé en matériel sur iPad/iPhone, AV1 si l'appareil le décode en matériel, comme l'iPhone 17), ou forcé (H.264, AV1, H.265, VP9). Changement à chaud, sans couper le live.
- **Appel** : son du PC + voix de Ruben mixés en stéréo haute qualité vers l'iPad ; micro de l'iPad vers le PC. Indicateurs de qui parle des deux côtés. Anti‑écho : Chrome/Edge (version 141 et plus) retirent du son capturé la voix du spectateur jouée par StreamCast, elle ne lui revient donc pas. Le spectateur règle séparément le volume du jeu et de la voix ; Ruben règle le volume de la voix des spectateurs.
- **Lecteur** : plein écran (StreamCast ou lecteur iPad natif), mini‑lecteur (Picture‑in‑Picture), Ajuster / Remplir, zoom à deux doigts et double‑tap, statistiques (résolution, FPS, débit, latence), latence minimale ou fluide.
- **Écrans HDR (OLED…)** : avec le HDR de Windows, certaines captures arrivent trop claires et délavées. Au lancement du live, StreamCast affiche une seconde un écran noir puis gris pour mesurer l'éclaircissement, et corrige les couleurs sur la carte graphique avant l'envoi (Réglages › Couleurs HDR : Auto, Manuelle ou Désactivée). Si la capture est déjà correcte, rien n'est modifié.
- **Retour du stream** : aperçu de la capture, vignette de ce que voit le spectateur (« Vue de Léa »), qualité de son réseau, et fenêtre **Mini‑retour** au‑dessus du jeu.
- **Chat et réactions**, liste des spectateurs avec qualité reçue, exclusion, validation des spectateurs (option), sons et notifications Windows.
- **Reconnexion automatique** si le réseau coupe ou si le live redémarre.
- **Notification « Ruben est en live »** sur l'iPad / l'iPhone, qui ouvre le live d'un toucher.
- **Relais de connexion** (optionnel) pour les réseaux qui bloquent la connexion directe.

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

### Notification « Ruben est en live »

Rien à configurer : les clés de notification sont créées automatiquement au premier usage et gardées dans le stockage Netlify (ou fournies via `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`).

- Sur l'iPad / l'iPhone, Apple n'autorise les notifications que pour l'app **ajoutée à l'écran d'accueil** : l'ouvrir depuis l'icône, puis **Me prévenir quand Ruben est en live** (écran d'attente ou Réglages › Notifications).
- Au lancement d'un live, chaque appareil inscrit reçoit la notification ; la toucher ouvre le live directement. Un rechargement de la page pendant un live ne renvoie pas de notification, et deux lives rapprochés (moins de 5 minutes) n'en envoient qu'une.

### Relais de connexion (optionnel)

La connexion directe PC → iPad marche sur la plupart des réseaux. Certains (4G/5G, Wi‑Fi d'hôtel, d'école ou d'entreprise) la bloquent : le relais fait alors passer le stream par un serveur, seulement dans ces cas-là. La ligne **Relais** de la vérification indique s'il est activé.

Pour l'activer avec Cloudflare :

1. Crée un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com).
2. Section **Realtime** › **TURN** : crée une clé TURN et note le **TURN Token ID** et l'**API Token** affichés.
3. Dans Netlify : **Project configuration › Environment variables**, ajoute `CF_TURN_KEY_ID` (TURN Token ID) et `CF_TURN_API_TOKEN` (API Token), puis redéploie.

Cloudflare offre 1 000 Go par mois (0,05 $/Go au‑delà). Le relais ne sert que lorsque la connexion directe échoue ; à titre indicatif, un live en 1440p consomme environ 9 Go par heure.

Autres fournisseurs possibles : Metered (`METERED_DOMAIN`, `METERED_API_KEY`) ou n'importe quel serveur TURN (`TURN_URLS` séparées par des virgules, `TURN_USERNAME`, `TURN_CREDENTIAL`).

## Conseils pour la meilleure qualité

- PC en **Ethernet**, iPad en Wi‑Fi **5 GHz ou 6 GHz** près de la box.
- Chrome/Edge avec l'**accélération matérielle** activée : les stats du live indiquent *GPU* quand l'encodage passe par la carte graphique.
- Jeux en **plein écran fenêtré** (borderless) pour une capture fluide.
- Écran HDR : garde la fenêtre StreamCast visible sur l'écran partagé au lancement du live (mesure des couleurs). Si la correction ne suffit pas, **Win + Alt + B** coupe le HDR de Windows le temps du live.
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
