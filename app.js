/* app.js
   WebSerial-enabled mockup for ESP32 firmware upload.
   - Carousel UI (select firmware/board/screen)
   - Choose .bin file or load URL (CORS required)
   - Connect to serial port with WebSerial API
   - Send binary chunked with progress and logs
*/

/* --------- UTIL: logs & ui helpers --------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function log(msg) {
  const el = document.createElement('div');
  el.className = 'log';
  el.textContent = `[${(new Date()).toLocaleTimeString()}] ${msg}`;
  $('#logs').appendChild(el);
  $('#logs').scrollTop = $('#logs').scrollHeight;
}

function setSummary({fw, board, screen, fileName}) {
  $('#sum-fw').textContent = fw || '—';
  $('#sum-board').textContent = board || '—';
  $('#sum-screen').textContent = screen || '—';
  $('#sum-file').textContent = fileName || 'No file';
}

/* --------- CAROUSEL logic (reusable) --------- */
function createCarousel(rootId, onSelect) {
  const root = document.getElementById(rootId);
  if (!root) return;
  const carousel = root.querySelector('.carousel');
  const prev = root.querySelector('.prev');
  const next = root.querySelector('.next');
  const items = Array.from(root.querySelectorAll('.item'));
  let index = items.findIndex(i => i.classList.contains('active'));
  if (index < 0) index = 0;

  function update() {
    items.forEach((it, i) => it.classList.toggle('active', i === index));
    // center translate calculation: keep center item in view
    const centerOffset = (index - Math.floor(items.length/2)) * (items[0].offsetWidth + 28);
    carousel.style.transform = `translateX(${-centerOffset}px)`;
    const active = items[index];
    if (onSelect) onSelect(active, index);
  }

  prev.addEventListener('click', () => {
    index = (index - 1 + items.length) % items.length;
    update();
  });
  next.addEventListener('click', () => {
    index = (index + 1) % items.length;
    update();
  });

  // allow clicking directly on item
  items.forEach((it, idx) => {
    it.addEventListener('click', () => {
      index = idx;
      update();
    });
  });

  // initial layout update (delay to allow images to size)
  setTimeout(update, 30);
  return {update, items, getIndex: ()=>index};
}

/* --------- initialize carousels and summary updates --------- */
let fwChosen = {name:'Chatbot AI', fileName:null, binBlob:null, binUrl:null};
let boardChosen = {name:'ESP32-S3 M16R8'};
let screenChosen = {name:'OLED 0.91"'};

const fwCar = createCarousel('fw-carousel', (active) => {
  const title = active.querySelector('.meta .title').textContent;
  fwChosen.name = title;
  setSummary({fw:fwChosen.name, board:boardChosen.name, screen:screenChosen.name, fileName: fwChosen.fileName});
});
const hwCar = createCarousel('hw-carousel', (active) => {
  const title = active.querySelector('.meta .title').textContent;
  boardChosen.name = title;
  setSummary({fw:fwChosen.name, board:boardChosen.name, screen:screenChosen.name, fileName: fwChosen.fileName});
});
const scCar = createCarousel('sc-carousel', (active) => {
  const title = active.querySelector('.meta .title').textContent;
  screenChosen.name = title;
  setSummary({fw:fwChosen.name, board:boardChosen.name, screen:screenChosen.name, fileName: fwChosen.fileName});
});

/* --------- File input / URL load for firmware --------- */
$('#fw-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  fwChosen.fileName = f.name;
  fwChosen.binBlob = f;
  fwChosen.binUrl = null;
  setSummary({fw:fwChosen.name, board:boardChosen.name, screen:screenChosen.name, fileName: fwChosen.fileName});
  log(`Selected file ${f.name}`);
});

$('#btn-load-url').addEventListener('click', async () => {
  const url = $('#bin-url').value.trim();
  if (!url) { log('No URL provided'); return; }
  try {
    log(`Fetching binary from URL: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    const ab = await res.arrayBuffer();
    // create blob
    fwChosen.binBlob = new Blob([ab], {type:'application/octet-stream'});
    fwChosen.binUrl = url;
    fwChosen.fileName = url.split('/').pop();
    setSummary({fw:fwChosen.name, board:boardChosen.name, screen:screenChosen.name, fileName: fwChosen.fileName});
    log(`Loaded ${fwChosen.fileName} (${ab.byteLength} bytes)`);
  } catch (err) {
    log('Error loading URL: ' + err.message);
  }
});

/* --------- WebSerial: connect / send --------- */
let port = null;
let writer = null;

async function connectSerial() {
  if (!('serial' in navigator)) {
    log('Web Serial API not supported in this browser.');
    alert('Trình duyệt không hỗ trợ Web Serial API. Dùng Chrome/Edge và chạy trên HTTPS hoặc localhost.');
    return;
  }
  try {
    log('Requesting serial port...');
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    log('Serial port opened.');

    // optional: set signals DTR/RTS etc (depends on board)
    // if (port.setSignals) await port.setSignals({ dataTerminalReady: true, requestToSend: true });

    writer = port.writable.getWriter();
    $('#btn-connect').disabled = true;
    $('#btn-disconnect').disabled = false;
    $('#btn-flash').disabled = !fwChosen.binBlob;
    log('Ready for flashing.');
  } catch (err) {
    log('Error opening serial: ' + err.message);
  }
}

async function disconnectSerial() {
  try {
    if (writer) { await writer.releaseLock(); writer = null; }
    if (port) { await port.close(); port = null; }
    $('#btn-connect').disabled = false;
    $('#btn-disconnect').disabled = true;
    $('#btn-flash').disabled = true;
    log('Serial port closed.');
  } catch (err) {
    log('Error closing serial: ' + err.message);
  }
}

/* send binary in chunks and update progress
   - blobOrBuffer: Blob or ArrayBuffer
   - chunkSize: recommended 16KB or 32KB
*/
async function sendFirmware(blobOrBuffer, onProgress = ()=>{}) {
  if (!port) throw new Error('No serial port open.');
  // ensure writer exists
  if (!writer) writer = port.writable.getWriter();

  // normalize to ArrayBuffer
  let ab;
  if (blobOrBuffer instanceof Blob) {
    ab = await blobOrBuffer.arrayBuffer();
  } else if (blobOrBuffer instanceof ArrayBuffer) {
    ab = blobOrBuffer;
  } else {
    throw new Error('sendFirmware expects Blob or ArrayBuffer');
  }

  const total = ab.byteLength;
  const chunkSize = 16 * 1024; // 16KB
  let offset = 0;

  log(`Start sending ${total} bytes in ${Math.ceil(total/chunkSize)} chunks...`);
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const slice = ab.slice(offset, end);
    const u8 = new Uint8Array(slice);
    // send bytes
    try {
      await writer.write(u8);
    } catch (err) {
      log('Write error: ' + err.message);
      throw err;
    }
    offset = end;
    const pct = Math.round((offset / total) * 100);
    onProgress(pct);
    // small pause to not overwhelm some boards (adjust if needed)
    await new Promise(r => setTimeout(r, 10));
  }

  log('Finished sending firmware data.');
  // optional flush / release writer but keep open for responses
}

/* UI: button handlers for connect, disconnect, flash */
$('#btn-connect').addEventListener('click', async () => {
  await connectSerial();
});

$('#btn-disconnect').addEventListener('click', async () => {
  await disconnectSerial();
});

$('#btn-flash').addEventListener('click', async () => {
  if (!fwChosen.binBlob) {
    alert('Vui lòng chọn file .bin (hoặc load URL) trước khi nạp.');
    return;
  }
  if (!port) {
    alert('Chưa kết nối thiết bị. Nhấn "Kết nối" để chọn cổng.');
    return;
  }

  // Confirm before flash
  if (!confirm(`Bạn chắc chắn muốn nạp ${fwChosen.fileName} lên ${boardChosen.name}?`)) return;

  try {
    // prepare blob as array buffer
    const blob = fwChosen.binBlob;
    $('#btn-flash').disabled = true;
    log('Preparing to flash...');

    // update UI progress
    const onProgress = pct => {
      $('#progress-bar').style.width = pct + '%';
      $('#progress-text').textContent = pct + '%';
    };

    await sendFirmware(blob, onProgress);

    // done
    $('#progress-bar').style.width = '100%';
    $('#progress-text').textContent = '100%';
    log('Nạp firmware hoàn tất (data sent). Kiểm tra bootloader/board để xác nhận flash thành công.');
  } catch (err) {
    log('Flashing error: ' + err.message);
    alert('Lỗi khi nạp: ' + err.message);
  } finally {
    $('#btn-flash').disabled = false;
  }
});

/* enable flash button when file chosen & port open */
setInterval(()=>{
  $('#btn-flash').disabled = !(fwChosen.binBlob && port);
}, 500);

/* initial summary display */
setSummary({fw:fwChosen.name, board:boardChosen.name, screen:screenChosen.name, fileName:fwChosen.fileName});
log('UI ready.');
