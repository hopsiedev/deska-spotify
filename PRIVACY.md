# Privacidad

**Qué pasa por el relé** (`deska-spotify-relay.xhopsiedev.workers.dev`): el título, artista, álbum, posición, duración, volumen y portada de lo que suena en tu Spotify, el estado de reproducción, y los comandos que envías (play/pausa, siguiente, anterior, volumen, salto). El secreto de autenticación no se envía en URLs ni parámetros de búsqueda: viaja en cabeceras HTTP (`Authorization: Bearer`) o dentro del canal WebSocket autenticado.

**Qué no ve ni guarda**: tu cuenta de Spotify, contraseñas, tokens de Spotify, tu historial, listas de reproducción o el audio. El companion no usa la API de Spotify: lee el estado de la app de escritorio de tu PC a través de las APIs multimedia de Windows (SMTC).

**Qué se guarda en el servidor**: el hash SHA-256 de tu clave de emparejamiento, el último estado y la última portada (para mostrarlos al abrir el panel). Una pareja sin actividad durante 30 días se borra automáticamente. No hay analítica ni cookies.

**Tu código de emparejamiento** se guarda en el almacenamiento del panel de Deska (`deska.storage`) y en `config.json` del companion en tu PC. Quien lo tenga puede controlar tu reproducción: no lo compartas. En el panel, *Nuevo código* revoca y destruye la pareja anterior en el relé de inmediato.

**Quitarlo todo**: en tu PC, ejecuta el comando de desinstalación que muestra el panel (`irm https://raw.githubusercontent.com/hopsiedev/deska-spotify/v1.0.6/installers/uninstall.ps1 | iex`) y, en el panel, pulsa *Nuevo código* o desinstala el panel en Deska.
