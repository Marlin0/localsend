let imgScale = 1; let imgPosX = 0; let imgPosY = 0; let isDragging = false; let startX = 0; let startY = 0;
let startTouchDist = 0; let startTouchScale = 1;

let currentLightboxImgUrl = ""; let isDrawing = false; let paintStartX = 0; let paintStartY = 0;
let canvasHistoryBackup = null; let baseImageObj = null;

let undoStack = []; let redoStack = [];
let camScale = 1; let camPosX = 0; let camPosY = 0;
let isCamPanning = false; let camStartX = 0; let camStartY = 0;

let pViewportTouchDist = 0; let pViewportTouchScale = 1;
let pViewportTouchMidX = 0; let pViewportTouchMidY = 0;

const paintCanvas = document.getElementById('paint-canvas');
const paintCtx = paintCanvas.getContext('2d');
const paintViewport = document.getElementById('paint-canvas-viewport');

function initLightboxEvents() {
    const wrapper = document.getElementById('lightbox-wrapper'); const img = document.getElementById('lightbox-img');
    wrapper.addEventListener('wheel', (e) => {
        e.preventDefault(); if (e.deltaY < 0) imgScale += 0.12; else imgScale = Math.max(0.15, imgScale - 0.12); applyImgTransform();
    }, { passive: false });
    img.addEventListener('mousedown', (e) => { 
        if (e.button !== 0) return; isDragging = true; startX = e.clientX - imgPosX; startY = e.clientY - imgPosY; e.stopPropagation(); 
    });
    window.addEventListener('mousemove', (e) => { if (!isDragging) return; imgPosX = e.clientX - startX; imgPosY = e.clientY - startY; applyImgTransform(); });
    window.addEventListener('mouseup', () => { isDragging = false; });
    document.getElementById('lightbox-true-size-btn').addEventListener('click', (e) => {
        e.stopPropagation(); img.style.maxWidth = 'none'; img.style.maxHeight = 'none'; imgScale = 1; imgPosX = 0; imgPosY = 0; applyImgTransform();
    });
    document.getElementById('lightbox-reset-btn').addEventListener('click', (e) => { e.stopPropagation(); resetLightboxState(); });
    wrapper.addEventListener('click', (e) => { if (e.target === wrapper) document.getElementById('lightbox').style.display = 'none'; });
    document.getElementById('lightbox-close-btn').addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('lightbox').style.display = 'none'; });
}

function initMobileTouchEvents() {
    const img = document.getElementById('lightbox-img');
    img.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) { isDragging = true; startX = e.touches[0].clientX - imgPosX; startY = e.touches[0].clientY - imgPosY; } 
        else if (e.touches.length === 2) { isDragging = false; startTouchDist = getTouchDistance(e.touches); startTouchScale = imgScale; }
    });
    img.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (e.touches.length === 1 && isDragging) { imgPosX = e.touches[0].clientX - startX; imgPosY = e.touches[0].clientY - startY; applyImgTransform(); } 
        else if (e.touches.length === 2) {
            const currentDist = getTouchDistance(e.touches);
            if (startTouchDist > 0) { imgScale = Math.max(0.15, Math.min(8, startTouchScale * (currentDist / startTouchDist))); applyImgTransform(); }
        }
    }, { passive: false });
    img.addEventListener('touchend', (e) => { isDragging = false; if (e.touches.length < 2) startTouchDist = 0; });
}

function getTouchDistance(touches) { return Math.sqrt(Math.pow(touches[0].clientX - touches[1].clientX, 2) + Math.pow(touches[0].clientY - touches[1].clientY, 2)); }
function applyImgTransform() { document.getElementById('lightbox-img').style.transform = `translate(${imgPosX}px, ${imgPosY}px) scale(${imgScale})`; }
function resetLightboxState() { const img = document.getElementById('lightbox-img'); img.style.maxWidth = '90%'; img.style.maxHeight = '80vh'; imgScale = 1; imgPosX = 0; imgPosY = 0; isDragging = false; applyImgTransform(); }

function openLightbox(url) {
    resetLightboxState(); document.getElementById('lightbox-img').src = url; currentLightboxImgUrl = url;
    document.getElementById('lightbox-download-btn').onclick = (e) => { e.stopPropagation(); downloadFile(url, currentBlobToUrlMap.get(url) || "image.png"); };
    document.getElementById('lightbox').style.display = 'flex';
}

function initPaintEvents() {
    const paintBtn = document.getElementById('lightbox-paint-btn');
    const paintContainer = document.getElementById('paint-container');
    const toolSelect = document.getElementById('paint-tool');
    const colorInput = document.getElementById('paint-color');
    const sizeInput = document.getElementById('paint-size');
    const sizeValSpan = document.getElementById('size-val');
    
    const undoBtn = document.getElementById('paint-undo-btn');
    const redoBtn = document.getElementById('paint-redo-btn');

    sizeInput.addEventListener('input', () => { sizeValSpan.innerText = sizeInput.value + "px"; });

    function pushToHistory() {
        undoStack.push(paintCtx.getImageData(0, 0, paintCanvas.width, paintCanvas.height));
        redoStack = []; 
        updateHistoryButtons();
    }

    function updateHistoryButtons() {
        undoBtn.disabled = (undoStack.length <= 1);
        redoBtn.disabled = (redoStack.length === 0);
    }

    undoBtn.addEventListener('click', () => {
        if (undoStack.length > 1) {
            const current = undoStack.pop(); redoStack.push(current);
            const previous = undoStack[undoStack.length - 1];
            paintCtx.putImageData(previous, 0, 0); updateHistoryButtons();
        }
    });

    redoBtn.addEventListener('click', () => {
        if (redoStack.length > 0) {
            const next = redoStack.pop(); undoStack.push(next);
            paintCtx.putImageData(next, 0, 0); updateHistoryButtons();
        }
    });

    paintBtn.addEventListener('click', (e) => {
        e.stopPropagation(); if (!currentLightboxImgUrl) return;
        baseImageObj = new Image();
        baseImageObj.src = currentLightboxImgUrl;
        baseImageObj.onload = () => {
            paintCanvas.width = baseImageObj.naturalWidth || baseImageObj.width;
            paintCanvas.height = baseImageObj.naturalHeight || baseImageObj.height;
            paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
            paintCtx.drawImage(baseImageObj, 0, 0);

            undoStack = []; redoStack = [];
            undoStack.push(paintCtx.getImageData(0, 0, paintCanvas.width, paintCanvas.height));
            updateHistoryButtons();
            fitCanvasToViewport();

            document.getElementById('lightbox-wrapper').style.visibility = 'hidden';
            document.getElementById('lightbox-controls').style.visibility = 'hidden';
            paintContainer.style.display = "flex";
        };
    });

    function fitCanvasToViewport() {
        const containerW = paintViewport.clientWidth - 20;
        const containerH = paintViewport.clientHeight - 20;
        camScale = Math.min(containerW / paintCanvas.width, containerH / paintCanvas.height, 1);
        camPosX = 0; camPosY = 0;
        applyCameraTransform();
    }

    function applyCameraTransform() { paintCanvas.style.transform = `translate(${camPosX}px, ${camPosY}px) scale(${camScale})`; }
    document.getElementById('paint-reset-cam-btn').addEventListener('click', fitCanvasToViewport);

    paintViewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) camScale += 0.08; else camScale = Math.max(0.08, camScale - 0.08);
        applyCameraTransform();
    }, { passive: false });

    function getCanvasMappedPos(e, isTouch) {
        const rect = paintCanvas.getBoundingClientRect();
        const clientX = isTouch ? e.touches[0].clientX : e.clientX;
        const clientY = isTouch ? e.touches[0].clientY : e.clientY;
        return {
            x: (clientX - rect.left) * (paintCanvas.width / rect.width),
            y: (clientY - rect.top) * (paintCanvas.height / rect.height)
        };
    }

    function startPaintOrPan(e, isTouch) {
        const isRightClick = !isTouch && e.button === 2;
        if (isTouch && e.touches.length === 2) {
            isDrawing = false; isCamPanning = true;
            pViewportTouchDist = getTouchDistance(e.touches);
            pViewportTouchScale = camScale;
            pViewportTouchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            pViewportTouchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            camStartX = pViewportTouchMidX - camPosX;
            camStartY = pViewportTouchMidY - camPosY;
            return;
        }
        if (isRightClick) { isCamPanning = true; camStartX = e.clientX - camPosX; camStartY = e.clientY - camPosY; return; }
        if (isTouch && e.touches.length > 2) return;

        isDrawing = true;
        const pos = getCanvasMappedPos(e, isTouch);
        paintStartX = pos.x; paintStartY = pos.y;

        paintCtx.strokeStyle = colorInput.value; paintCtx.fillStyle = colorInput.value;
        paintCtx.lineWidth = parseInt(sizeInput.value);
        paintCtx.lineCap = "round"; paintCtx.lineJoin = "round";
        paintCtx.font = `${parseInt(sizeInput.value) * 3}px -apple-system, sans-serif`;

        if (toolSelect.value === 'brush') {
            paintCtx.beginPath(); paintCtx.moveTo(pos.x, pos.y);
        } else {
            canvasHistoryBackup = paintCtx.getImageData(0, 0, paintCanvas.width, paintCanvas.height);
        }

        if (toolSelect.value === 'text') {
            isDrawing = false;
            setTimeout(() => {
                const text = prompt("请输入您要插入的文字：");
                if (text && text.trim() !== "") { paintCtx.fillText(text.trim(), paintStartX, paintStartY); pushToHistory(); }
            }, 50);
        }
    }

    function movePaintOrPan(e, isTouch) {
        if (isTouch && e.touches.length === 2 && isCamPanning) {
            e.preventDefault();
            const currentDist = getTouchDistance(e.touches);
            const curMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const curMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            camPosX = curMidX - camStartX; camPosY = curMidY - camStartY;
            if (pViewportTouchDist > 0) { camScale = Math.max(0.06, Math.min(15, pViewportTouchScale * (currentDist / pViewportTouchDist))); }
            applyCameraTransform(); return;
        }
        if (!isTouch && isCamPanning) { camPosX = e.clientX - camStartX; camPosY = e.clientY - camStartY; applyCameraTransform(); return; }
        if (!isDrawing) return;
        if(isTouch) e.preventDefault();
        
        const pos = getCanvasMappedPos(e, isTouch);
        const currentTool = toolSelect.value;

        if (currentTool === 'brush') {
            paintCtx.lineTo(pos.x, pos.y); paintCtx.stroke();
        } else if ((currentTool === 'rect' || currentTool === 'circle') && canvasHistoryBackup) {
            paintCtx.putImageData(canvasHistoryBackup, 0, 0);
            paintCtx.beginPath();
            const w = pos.x - paintStartX; const h = pos.y - paintStartY;
            if (currentTool === 'rect') paintCtx.rect(paintStartX, paintStartY, w, h);
            else if (currentTool === 'circle') paintCtx.arc(paintStartX, paintStartY, Math.sqrt(w*w + h*h), 0, 2 * Math.PI);
            paintCtx.stroke();
        }
    }

    function stopPaintOrPan() { 
        if (isDrawing && toolSelect.value !== 'text') { pushToHistory(); }
        isDrawing = false; isCamPanning = false; canvasHistoryBackup = null; 
    }

    paintViewport.addEventListener('contextmenu', e => e.preventDefault());
    paintViewport.addEventListener('mousedown', (e) => startPaintOrPan(e, false));
    paintViewport.addEventListener('mousemove', (e) => movePaintOrPan(e, false));
    window.addEventListener('mouseup', stopPaintOrPan);

    paintViewport.addEventListener('touchstart', (e) => startPaintOrPan(e, true));
    paintViewport.addEventListener('touchmove', (e) => movePaintOrPan(e, true), { passive: false });
    paintViewport.addEventListener('touchend', stopPaintOrPan);

    document.getElementById('paint-exit-btn').addEventListener('click', () => { 
        paintContainer.style.display = "none"; 
        document.getElementById('lightbox-wrapper').style.visibility = 'visible'; document.getElementById('lightbox-controls').style.visibility = 'visible';
    });

    document.getElementById('paint-save-local-btn').addEventListener('click', () => {
        paintCanvas.toBlob((blob) => {
            if (!blob) return alert("生成图片失败");
            const url = URL.createObjectURL(blob); downloadFile(url, "Markup_Local_" + Date.now() + ".png");
        }, 'image/png');
    });

    document.getElementById('paint-send-btn').addEventListener('click', () => {
        if (!dataChannel || dataChannel.readyState !== 'open') return alert("发送失败，通道断开！");
        paintCanvas.toBlob((blob) => {
            if (!blob) return alert("生成图片失败！");
            executeFileSending(new File([blob], "Markup_" + Date.now() + ".png", { type: "image/png" }));
            paintContainer.style.display = "none"; 
            document.getElementById('lightbox-wrapper').style.visibility = 'visible'; document.getElementById('lightbox-controls').style.visibility = 'visible';
            document.getElementById('lightbox').style.display = 'none';
        }, 'image/png');
    });
}

initLightboxEvents();
initMobileTouchEvents();
initPaintEvents();