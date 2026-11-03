NOTAS DE LA VERSION: FUNCIONA EL SISTEMA DE BACKUPS DE PREGUNTAS, Y HAY DESCARGADAS PREGUNTAS PARA QUE SE PUEDA HACER
CADA MES O ASI DEJARA DE FUNCIONAR LA BASE DE DATOS Y HABRIA QUE CREAR OTRA NUEVA.

# ¿Cuánto me conoces? — versión para Render

Contenido:
- `public/index.html`  la app (modos: local, a distancia por códigos, online en directo de 2 y modo grupo sin límite de jugadores)
- `server.js`          servidor Node: sirve la app y conecta las salas en directo por WebSocket (2 jugadores por sala y sin límite práctico en las de grupo)
- `questions-api.js`   API de preguntas (PostgreSQL): editor, carga inicial y restauración
- `questions-seed.json` las 1500 preguntas originales (se cargan en la base de datos UNA sola vez)
- `package.json`       dependencias (solo `ws`)
- `render.yaml`        configuración opcional para Render (Blueprint)

## Publicar en Render (gratis)
1. Sube esta carpeta a un repositorio de GitHub (`package.json` debe quedar en la raíz).
2. En render.com: **New + → Web Service** y elige el repositorio.
3. Ajustes: Runtime **Node**, Build Command `npm install`, Start Command `node server.js`, plan **Free**.
4. Pulsa **Create Web Service**. Cuando diga *Live*, abre tu enlace `https://TU-NOMBRE.onrender.com`.

Probar en tu ordenador: `npm install`, luego `npm start`, y abre http://localhost:3000

## Preguntas y base de datos
- Las preguntas **ya no están en el HTML**: viven en la base de datos y se editan desde la pestaña ✏️ Editor (código de acceso `ADMIN_CODE`).
- Al arrancar, el servidor carga `questions-seed.json` en la base de datos **una sola vez** (si ya había preguntas propias, las conserva detrás de las originales). Cuando Render borra la base de datos (cada mes) se vuelven a cargar solas las originales.

## Backups
- En cada dispositivo donde hayas entrado alguna vez al editor, al abrir el juego se guarda **un backup al día** (a partir de las 9:00, hora de Madrid) en el propio navegador (IndexedDB) y se **descarga** como archivo `backup-preguntas-AAAA-MM-DD.json`. Los backups no se borran nunca (no existe ninguna función para borrarlos).
- Para descargar un archivo en cada apertura y no solo uno al día, pon `BK_DL_EVERY_OPEN=true` en `public/index.html`.
- En ✏️ Editor → 💾 Backups: descargar un backup ahora, ver/descargar/restaurar los guardados y restaurar desde un archivo. Si la base de datos se ha vaciado, aparece un aviso con un botón para restaurar el último backup. Antes de cada restauración se guarda una copia de lo que había.
