# ¿Cuánto me conoces? — versión para Render

Contenido:
- `public/index.html`  la app (modos: local, a distancia por códigos, online en directo de 2 y modo grupo sin límite de jugadores)
- `server.js`          servidor Node: sirve la app y conecta las salas en directo por WebSocket (2 jugadores por sala y sin límite práctico en las de grupo)
- `package.json`       dependencias (solo `ws`)
- `render.yaml`        configuración opcional para Render (Blueprint)

## Publicar en Render (gratis)
1. Sube esta carpeta a un repositorio de GitHub (`package.json` debe quedar en la raíz).
2. En render.com: **New + → Web Service** y elige el repositorio.
3. Ajustes: Runtime **Node**, Build Command `npm install`, Start Command `node server.js`, plan **Free**.
4. Pulsa **Create Web Service**. Cuando diga *Live*, abre tu enlace `https://TU-NOMBRE.onrender.com`.

Probar en tu ordenador: `npm install`, luego `npm start`, y abre http://localhost:3000
