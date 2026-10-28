# LiamTV phone controller

Static page (`index.html`, `css/controller.css`, `js/controller.js`) that turns any
phone into a remote for the LiamTV launcher and a gamepad for its emulator.

- Connects to the room the TV advertises (`liamtv-<CODE>`) through the public
  PeerJS handshake server, then talks to the TV directly over Wi-Fi (WebRTC data
  channel). Nothing is installed on the phone.
- `?c=KX7P` in the URL pre-fills the code (the TV's QR encodes this).
- Messages to the TV: `{t:'key',k}` (up/down/left/right/ok/back/home/games/recent/
  system/exit), `{t:'vol',d:-1|0|1}`, `{t:'pad',b:{up,down,left,right,a,b,x,y,l,r,
  start,select}}` full snapshots, `{t:'launch',name}`, `{t:'play',name}`, `{t:'ping'}`.
- From the TV: `welcome` (player slot, app list) and `state` (screen, game, games,
  players). The page switches to the gamepad when the TV is in a game.

Live at https://lmsnyri.github.io/liamtv-controller/ (GitHub Pages from the
`lmsnyri/liamtv-controller` repo, branch `main`). That address is `remote.url` in
`data/tiles.js`. To update: copy this folder's files into a checkout of the repo and push. `PREFIX`/`SIGNALING` at the top of
`js/controller.js` must match `remote.prefix` / `remote.signaling` there.
