# EchoCoach

Aplicación de escritorio (Electron, Windows) que escucha el **audio de tu PC** (videos, llamadas, entrevistas simuladas), lo transcribe casi en tiempo real con Groq Whisper y te sugiere una respuesta por cada pregunta detectada. Está pensada para **practicar**: comparar tus respuestas con las de una IA y prepararte para entrevistas.

## Características

- Captura de la salida de audio de Windows (loopback), sin cables virtuales. En la configuración eliges qué salida escuchar (altavoces, auriculares, "Chat" o "Gaming" de SteelSeries Sonar, etc.) o una entrada como un micrófono.
- Transcripción rápida con detección de pausas (`whisper-large-v3-turbo`). Descarta ruidos, música y notificaciones que no son voz.
- Respuestas cortas y naturales, como las diría una persona.
- Conversaciones guardadas automáticamente, con **Historial** para reabrirlas o borrarlas. Al **Detener** (o pulsar **Nueva**) se guarda la conversación y la pantalla queda limpia para empezar otra.
- Una respuesta sugerida por pregunta, en formato de conversación (las anteriores se minimizan sin perder contexto).
- Retos técnicos: tarea, pasos y comandos uno por uno, código completo con botón **Copiar**, salida esperada y qué decir mientras programas.
- Dos idiomas: **interviewleng** (idioma de la entrevista) y **mainleng** (tu idioma, para explicaciones y traducciones).
- Currículum en PDF opcional para personalizar las respuestas.
- Barra de preguntas manuales, capturas de pantalla (botón de cámara), y pegar o arrastrar imágenes.
- Selector de LLM de chat y de programación en la configuración.

## Requisitos

- Windows 10/11.
- [Node.js](https://nodejs.org) 18 o superior (incluye npm).
- Una API key gratuita de Groq: <https://console.groq.com/keys>.

## Instalación

```
git clone https://github.com/AydenXR/EchoCoach.git
cd EchoCoach
npm install
```

Si al ejecutar la app aparece un error de que falta el binario de Electron, ejecuta:

```
node node_modules\electron\install.js
```

## Configurar la API key

Elige una de estas opciones:

1. **Desde la app (recomendado):** abre la app, pulsa el engranaje, pega tu clave `gsk_...` y pulsa **Guardar**. Se valida contra Groq y se cifra con el almacén seguro del sistema. Si el almacén no está disponible, configura `GROQ_API_KEY` en el entorno.
2. **Archivo `.env`** (solo desarrollo): copia `.env.example` a `.env` y pon tu clave.

```
copy .env.example .env
```

Nunca subas tu `.env` ni compartas tu clave. El `.gitignore` ya los excluye.

## Uso de inicio a fin

1. Ejecuta la app:
   ```
   npm start
   ```
2. Pulsa el **engranaje** y revisa:
   - **mainleng:** tu idioma.
   - **API key de Groq.**
   - **Fuente de audio:** la salida de Windows cuyo audio quieres transcribir (por defecto, la predeterminada).
   - **Chat LLM** y **LLM de programación** (por defecto `openai/gpt-oss-120b`).
3. En la ventana principal elige **interviewleng**, el idioma en el que se hablará la entrevista (o "auto").
4. (Opcional) Pulsa **Elegir currículum (PDF)**. El texto queda solo en memoria y se usa para personalizar respuestas.
5. Pulsa **Iniciar**. Se escucha la salida elegida en la configuración; no hace falta compartir pantalla.
6. Reproduce el audio (un video, una llamada, una entrevista grabada). Lo transcrito aparece arriba, que puedes ocultar con **Ver transcripción**.
7. A la derecha verás la respuesta sugerida por cada pregunta. Las tarjetas antiguas se minimizan; haz clic en el título para abrirlas.
8. Para consultas propias, escribe en la barra inferior y pulsa **Enviar**. Por ejemplo: "dame los pasos para ejecutarlo".
9. Para adjuntar imágenes, pulsa el botón de **cámara** (captura la pantalla), o pega con `Ctrl+V`, o arrastra una imagen. Máximo 4 por mensaje.
10. Pulsa **Detener** al terminar: la conversación se guarda y todo queda limpio para una nueva. **Nueva** hace lo mismo sin detener la escucha, e **Historial** abre las guardadas.

### Imágenes y modelos de visión

Las imágenes usan `qwen/qwen3.8-27b`. En muchas cuentas de Groq está bloqueado por defecto: actívalo en <https://console.groq.com/settings/project/limits>. Si no, la tarjeta de respuesta mostrará un aviso.

## Límites y privacidad

- El audio transcrito, tu texto, tus capturas y el contenido del currículum se envían a la API de Groq. Revisa sus condiciones antes de usar material sensible.
- La clave guardada desde la app se cifra con el almacén del sistema; la alternativa `GROQ_API_KEY`/`.env` depende de que protejas esas fuentes. El log de la app está en `%APPDATA%\EchoCoach\app.log`.
- Las conversaciones se guardan como texto en `%APPDATA%\EchoCoach\conversations\` (preguntas y respuestas; de las imágenes solo se guarda cuántas había). Puedes borrarlas desde **Historial**.
- El plan gratuito de Groq tiene límite de peticiones por minuto; la app reintenta automáticamente ante un 429.
- La IA no tiene acceso a tus archivos ni a la consola.

## Uso responsable

EchoCoach es una herramienta de práctica y aprendizaje. Respeta las reglas de cada entrevista o evaluación real: no la uses para engañar a nadie ni para incumplir normas que prohíban asistencia externa.

## Compilar un instalador

```
npm run dist
```

Compila antes el capturador de audio nativo (`native/EchoLoopback.exe`, con el `csc.exe` que trae Windows, sin instalar nada) y lo incluye en el instalador. Para compilarlo solo: `npm run build:native`. El `.exe` no se sube a git, así que hay que generarlo en cada copia nueva; sin él, `npm start` no puede elegir la salida de audio. El resultado queda en `dist/`. Para distribuirlo, no incluyas tu `.env`.

## Solución de problemas

| Problema | Qué hacer |
| --- | --- |
| `git` no se reconoce | Reabre la terminal o agrega `C:\Program Files\Git\cmd` al PATH. |
| No se transcribe nada | Elige en la configuración la **Fuente de audio** correcta (con SteelSeries Sonar suele ser "Chat" o "Gaming") y comprueba que la clave es válida. |
| Solo oye el navegador u otra app | Esa app suena por otra salida de Windows: elígela en **Fuente de audio**. |
| La fuente de audio no cambia | Falta `native/EchoLoopback.exe`: ejecuta `npm run build:native`. |
| Aparece "you" o texto raro en silencio | Es un artefacto de Whisper; la app ya lo filtra. |
| Error 429 | Estás en el límite del plan gratuito; espera unos segundos. |
| La captura no responde con imágenes | Habilita el modelo Qwen en tu proyecto de Groq (ver arriba). |

## Licencia

[PolyForm Noncommercial 1.0.0](LICENSE). El código es público y puedes usarlo, estudiarlo, modificarlo y compartirlo para **fines no comerciales**. Está prohibido venderlo o usarlo con fines comerciales. Estrictamente, al restringir el uso comercial no cumple la definición de "open source" de la OSI; es software de código abierto a la vista (*source-available*).
