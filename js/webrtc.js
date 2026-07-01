const statusEl = document.getElementById('status');
let ws; let peerConnection; let dataChannel; let myRole = ""; let roomCode = "";
let pendingFileMeta = null; let receivedChunks = []; let currentBlobToUrlMap = new Map(); 
let clipboardFile = null; let allowShareStatus = true; let checkOnlineInterval = null; let peerIsOnline = true; 

let isTransferCancelled = false;
let transferStats = { totalBytes: 0, receivedBytes: 0, startTime: 0, lastUpdatedTime: 0, lastId: null };

const CHUNK_SIZE = 32768; 
let iceConnectionTimer = null; 

// 语音录制核心上下文变量
let mediaRecorder = null; let audioChunks = []; let audioStartTime = 0;
let isRecordingActive = false; let recordStartY = 0; let isCancelDetected = false;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.miwifi.com:3478' },
        { urls: 'stun:stun.chat.bilibili.com:3478' },
        { urls: 'stun:stun.hitv.com:3478' }
    ]
};

const SoundEngine = {
    ctx: null,
    init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
    play(type) {
        try {
            this.init(); if (!this.ctx) return;
            const now = this.ctx.currentTime;
            if (type === 'connect') {
                this.osc(523.25, 0.08, now, 'sine');
                this.osc(659.25, 0.12, now + 0.08, 'sine');
            } else if (type === 'disconnect') {
                this.osc(329.63, 0.12, now, 'triangle');
                this.osc(220.00, 0.18, now + 0.1, 'triangle');
            } else if (type === 'msg') {
                this.osc(587.33, 0.06, now, 'sine');
                this.osc(880.00, 0.15, now + 0.05, 'sine');
            } else if (type === 'done') {
                this.osc(523.25, 0.05, now, 'sine');
                this.osc(659.25, 0.05, now + 0.05, 'sine');
                this.osc(783.99, 0.12, now + 0.1, 'sine');
            }
        } catch(e) {}
    },
    osc(freq, duration, startTime, shape) {
        const oscNode = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        oscNode.type = shape; oscNode.frequency.setValueAtTime(freq, startTime);
        gainNode.gain.setValueAtTime(0.15, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        oscNode.connect(gainNode); gainNode.connect(this.ctx.destination);
        oscNode.start(startTime); oscNode.stop(startTime + duration);
    }
};

window.addEventListener('DOMContentLoaded', () => {
    const savedUrl = localStorage.getItem('localSendServerUrl');
    if (savedUrl) document.getElementById('server-url').value = savedUrl;
    
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
        document.getElementById('btn-desktop-screenshot').style.display = 'none';
        document.getElementById('btn-desktop-file').style.display = 'none';
        document.getElementById('btn-mobile-chooser').style.display = 'block';
    }

    document.body.addEventListener('click', () => SoundEngine.init(), { once: true });
    document.body.addEventListener('touchstart', () => SoundEngine.init(), { once: true });
    
    // 初始化语音录制交互监听
    initAudioRecordFeature();
});

function handleReceiverCodeKeyPress(e) {
    if (e.key === 'Enter') {
        const code = document.getElementById('input-code').value.trim();
        if (code.length === 6) { e.preventDefault(); connectToRoom(); }
    }
}

function chooseRole(role) {
    const serverUrl = document.getElementById('server-url').value.trim();
    if (!serverUrl) return alert("请输入信令服务器地址！");
    localStorage.setItem('localSendServerUrl', serverUrl);
    myRole = role;
    document.getElementById('role-zone').style.display = 'none';
    try { ws = new WebSocket(serverUrl); } catch (e) { alert("WebSocket连接失败！"); location.reload(); return; }
    
    ws.onopen = () => {
        if (role === 'sender') {
            document.getElementById('sender-panel').style.display = 'block';
            roomCode = Math.floor(100000 + Math.random() * 900000).toString();
            document.getElementById('generated-code').innerText = roomCode;
            statusEl.innerText = "已在公网开辟房间，等待接收方...";
            ws.send(jsonStr("join", { room_id: roomCode, role: "sender" }));
            initWebRTC(true);
        } else {
            document.getElementById('receiver-panel').style.display = 'block';
            statusEl.innerText = "请输入 6 位配对口令";
        }
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "error") {
            alert(message.message); statusEl.innerText = message.message; statusEl.style.color = "#ff4d4f"; return;
        }
        if (message.type === "peer_ready" && myRole === "receiver") {
            statusEl.innerText = "已寻获发送方，正在交换网络名片...";
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            ws.send(jsonStr("signal", { room_id: roomCode, data: offer }));
        }
        if (message.type === "signal") {
            const signalData = message.data;
            if (signalData.type === "offer") {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signalData));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                ws.send(jsonStr("signal", { room_id: roomCode, data: answer }));
            } else if (signalData.type === "answer") {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signalData));
            } else if (signalData.candidate) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(signalData));
            }
        }
    };
}

function connectToRoom() {
    roomCode = document.getElementById('input-code').value.trim();
    if (roomCode.length !== 6) return alert("请输入6位数字！");
    statusEl.innerText = "正在公网检索口令...";
    ws.send(jsonStr("join", { room_id: roomCode, role: "receiver" }));
    initWebRTC(false);
}

function initWebRTC(isSender) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    iceConnectionTimer = setTimeout(() => {
        if (peerConnection && peerConnection.connectionState !== 'connected') {
            statusEl.innerText = "⚠️ 打洞失败，当前网络环境受限。"; statusEl.style.color = "#ff4d4f";
        }
    }, 15000);

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
            clearTimeout(iceConnectionTimer); statusEl.innerText = "🟢 P2P 打洞成功！"; statusEl.style.color = "#52c41a";
            SoundEngine.play('connect');
        } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
            statusEl.innerText = "🔴 P2P 连接已断开"; statusEl.style.color = "#ff4d4f";
            SoundEngine.play('disconnect');
        }
    };

    if (!isSender) {
        dataChannel = peerConnection.createDataChannel("p2pChannel"); setupDataChannel(dataChannel);
    } else {
        peerConnection.ondatachannel = (event) => { dataChannel = event.channel; setupDataChannel(dataChannel); };
    }
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) ws.send(jsonStr("signal", { room_id: roomCode, data: event.candidate }));
    };
}

function setupDataChannel(channel) {
    channel.bufferedAmountLowThreshold = 262144;
    channel.onbufferedamountlow = () => { if (window.onDataChannelBufferLow) window.onDataChannelBufferLow(); };
    channel.onopen = () => {
        peerIsOnline = true; updateStatusText();
        document.getElementById('online-toggle-container').style.display = 'flex';
        document.getElementById('sender-panel').style.display = 'none';
        document.getElementById('receiver-panel').style.display = 'none';
        document.getElementById('transfer-zone').style.display = 'flex';
        if (ws) ws.close(); startOnlineStateTracker();
    };

    channel.onmessage = (event) => {
        if (typeof event.data === "string") {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "text") {
                    appendMessage("peer", data.content);
                    SoundEngine.play('msg');
                } else if (data.type === "file_meta") {
                    pendingFileMeta = data; receivedChunks = []; isTransferCancelled = false;
                    transferStats.totalBytes = data.size; transferStats.receivedBytes = 0;
                    transferStats.startTime = Date.now(); transferStats.lastUpdatedTime = Date.now(); transferStats.lastId = data.id;
                    
                    let isImg = data.fileType.startsWith("image/");
                    let isVid = data.fileType.startsWith("video/");
                    let isAud = data.fileType.startsWith("audio/") || data.name.endsWith(".opus") || data.name.endsWith(".webm") || data.name.endsWith(".wav");
                    
                    appendPlaceholder("peer", data.id, data.name, isImg, isVid, isAud);
                    SoundEngine.play('msg');
                } else if (data.type === "file_end") {
                    if (pendingFileMeta && !isTransferCancelled) {
                        const blob = new Blob(receivedChunks, { type: pendingFileMeta.fileType });
                        const url = URL.createObjectURL(blob);
                        currentBlobToUrlMap.set(url, pendingFileMeta.name);
                        
                        let isImg = pendingFileMeta.fileType.startsWith("image/");
                        let isVid = pendingFileMeta.fileType.startsWith("video/");
                        let isAud = pendingFileMeta.fileType.startsWith("audio/") || pendingFileMeta.name.endsWith(".opus") || pendingFileMeta.name.endsWith(".webm") || pendingFileMeta.name.endsWith(".wav");
                        
                        finalizePlaceholder(pendingFileMeta.id, url, pendingFileMeta.name, isImg, isVid, isAud);
                        pendingFileMeta = null; receivedChunks = []; peerIsOnline = true; updateStatusText();
                        SoundEngine.play('done');
                    }
                } else if (data.type === "transfer_cancel") handleRemoteCancel(data.id);
                else if (data.type === "ping") { if (allowShareStatus) dataChannel.send(JSON.stringify({ type: "pong" })); }
                else if (data.type === "pong") { peerIsOnline = true; updateStatusText(); }
            } catch (e) { appendMessage("peer", event.data); SoundEngine.play('msg'); }
        } else {
            if (isTransferCancelled) return;
            receivedChunks.push(event.data);
            transferStats.receivedBytes += event.data.byteLength;
            let now = Date.now();
            if (now - transferStats.lastUpdatedTime > 250 || transferStats.receivedBytes === transferStats.totalBytes) {
                let elapsed = (now - transferStats.startTime) / 1000;
                let speed = elapsed > 0 ? (transferStats.receivedBytes / elapsed) : 0;
                updateProgressBarElements(transferStats.lastId, transferStats.receivedBytes, transferStats.totalBytes, speed, speed > 0 ? Math.ceil((transferStats.totalBytes - transferStats.receivedBytes) / speed) : 0);
                transferStats.lastUpdatedTime = now;
            }
        }
    };
}

function cancelTransfer(id) {
    isTransferCancelled = true;
    try { if(dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify({ type: "transfer_cancel", id: id })); } catch(e){}
    applyCancelledStyle(id, "已取消传输"); receivedChunks = []; pendingFileMeta = null; updateStatusText();
    SoundEngine.play('disconnect');
}
function handleRemoteCancel(id) {
    isTransferCancelled = true; applyCancelledStyle(id, "对方已取消传输"); receivedChunks = []; pendingFileMeta = null; updateStatusText();
    SoundEngine.play('disconnect');
}
function applyCancelledStyle(id, text) {
    const barFill = document.getElementById(`bar-fill-${id}`); if (barFill) barFill.style.backgroundColor = '#ff4d4f';
    const percentEl = document.getElementById(`percent-${id}`); if (percentEl) percentEl.innerText = text;
    const placeholderBody = document.getElementById(`placeholder-body-${id}`);
    if (placeholderBody && (placeholderBody.classList.contains('img-placeholder') || placeholderBody.classList.contains('video-wrapper'))) {
        placeholderBody.innerHTML = `<span class="status-cancelled">❌ 传输中断</span>`;
    }
}
function updateStatusText() {
    const isOpen = dataChannel && dataChannel.readyState === 'open';
    if (!isOpen) { statusEl.innerText = "🔴 传输通道已断开"; statusEl.style.color = "#ff4d4f"; return; }
    statusEl.innerText = peerIsOnline ? "🟢 P2P已直连 (对方在线)" : "⏳ 对方未响应";
    statusEl.style.color = peerIsOnline ? "#52c41a" : "#fa8c16";
}
function toggleStatusSharing() { allowShareStatus = document.getElementById('allow-share-status').checked; }
function startOnlineStateTracker() {
    if (checkOnlineInterval) clearInterval(checkOnlineInterval);
    checkOnlineInterval = setInterval(() => {
        if (!(dataChannel && dataChannel.readyState === 'open')) return;
        if(pendingFileMeta || isTransferCancelled) return;
        peerIsOnline = false; try { dataChannel.send(JSON.stringify({ type: "ping" })); } catch(e){}
        setTimeout(updateStatusText, 1000);
    }, 5000);
}

function handleKeyPress(e) { if (e.key === 'Enter') sendMessage(); }
function sendMessage() {
    if (clipboardFile) { sendClipboardImage(); return; }
    const input = document.getElementById('msg-input'); const text = input.value.trim();
    if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ type: "text", content: text })); appendMessage("me", text); input.value = "";
    SoundEngine.play('done');
}
function sendFile() {
    const fileInput = document.getElementById('file-input'); const file = fileInput.files[0];
    if (!file || !dataChannel || dataChannel.readyState !== 'open') return;
    executeFileSending(file); fileInput.value = ""; 
}

function executeFileSending(file) {
    const fileId = "msg_" + Date.now() + "_" + Math.floor(Math.random()*1000);
    const isImg = file.type.startsWith("image/");
    const isVid = file.type.startsWith("video/");
    const isAud = file.type.startsWith("audio/") || file.name.endsWith(".opus") || file.name.endsWith(".webm") || file.name.endsWith(".wav");
    
    isTransferCancelled = false;
    appendPlaceholder("me", fileId, file.name, isImg, isVid, isAud);
    let senderStats = { totalBytes: file.size, sentBytes: 0, startTime: Date.now(), lastUpdatedTime: Date.now() };
    dataChannel.send(JSON.stringify({ type: "file_meta", id: fileId, name: file.name, size: file.size, fileType: file.type }));

    let offset = 0; const reader = new FileReader();
    const readNextChunk = () => {
        if (isTransferCancelled) return;
        if (offset >= file.size) {
            dataChannel.send(JSON.stringify({ type: "file_end" }));
            const fileUrl = URL.createObjectURL(file); currentBlobToUrlMap.set(fileUrl, file.name);
            finalizePlaceholder(fileId, fileUrl, file.name, isImg, isVid, isAud); updateStatusText(); 
            SoundEngine.play('done');
            return;
        }
        if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) { window.onDataChannelBufferLow = readNextChunk; return; }
        reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
    };
    reader.onload = (e) => {
        if (isTransferCancelled) return;
        try {
            dataChannel.send(e.target.result); offset += e.target.result.byteLength; senderStats.sentBytes += e.target.result.byteLength;
            let now = Date.now();
            if (now - senderStats.lastUpdatedTime > 250 || senderStats.sentBytes === senderStats.totalBytes) {
                let elapsed = (now - senderStats.startTime) / 1000; let speed = elapsed > 0 ? (senderStats.sentBytes / elapsed) : 0;
                updateProgressBarElements(fileId, senderStats.sentBytes, senderStats.totalBytes, speed, speed > 0 ? Math.ceil((senderStats.totalBytes - senderStats.sentBytes) / speed) : 0);
                senderStats.lastUpdatedTime = now;
            }
            readNextChunk(); 
        } catch(err){}
    };
    window.onDataChannelBufferLow = readNextChunk; readNextChunk();
}

function appendPlaceholder(role, id, filename, isImg, isVid, isAud) {
    const box = document.getElementById('msg-box');
    let contentHtml = "";
    if (isImg) {
        contentHtml = `<div class="img-placeholder" id="placeholder-body-${id}"><div class="spinner"></div><span>加载图片中...</span></div>`;
    } else if (isVid) {
        contentHtml = `<div class="video-wrapper" id="placeholder-body-${id}"><div class="img-placeholder" style="width:100%;"><div class="spinner"></div><span>缓冲视频中...</span></div></div>`;
    } else if (isAud) {
        contentHtml = `<div id="placeholder-body-${id}">🔊 语音传输中...</div>`;
    } else {
        contentHtml = `<div class="chat-file" id="placeholder-body-${id}">📁 ${filename}</div>`;
    }
    
    box.innerHTML += `<div class="msg-row ${role}" id="${id}"><div class="bubble">${contentHtml}<div class="progress-panel" id="progress-panel-${id}"><div class="progress-bar-bg"><div class="progress-bar-fill" id="bar-fill-${id}"></div></div><div class="progress-meta"><span id="percent-${id}">0%</span><span id="speed-${id}">0.00 MB/s</span><span id="eta-${id}">剩余 --:--</span><a class="cancel-link" id="cancel-btn-${id}" onclick="cancelTransfer('${id}')">🛑 取消</a></div></div></div></div>`;
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 30);
}

function updateProgressBarElements(id, received, total, speedBytes, etaSeconds) {
    const bar = document.getElementById(`bar-fill-${id}`); if(!bar || isTransferCancelled) return;
    let pct = Math.min(100, Math.floor((received / total) * 100)); bar.style.width = pct + "%";
    document.getElementById(`percent-${id}`).innerText = pct + "%";
    document.getElementById(`speed-${id}`).innerText = (speedBytes / (1024 * 1024)).toFixed(2) + " MB/s";
    if (pct >= 100) {
        document.getElementById(`eta-${id}`).innerText = "完成";
        if(document.getElementById(`cancel-btn-${id}`)) document.getElementById(`cancel-btn-${id}`).style.display = 'none';
    } else {
        document.getElementById(`eta-${id}`).innerText = `剩余 ${Math.floor(etaSeconds / 60)}:${etaSeconds % 60 < 10 ? '0' : ''}${etaSeconds % 60}`;
    }
}

function finalizePlaceholder(id, url, filename, isImg, isVid, isAud) {
    if(isTransferCancelled) return;
    if(document.getElementById(`progress-panel-${id}`)) document.getElementById(`progress-panel-${id}`).style.display = 'none';
    const bodyContainer = document.getElementById('placeholder-body-' + id); if(!bodyContainer) return;
    
    if (isImg) {
        bodyContainer.outerHTML = `<img src="${url}" class="chat-img" alt="${filename}" onclick="openLightbox('${url}')">`;
    } else if (isVid) {
        // 直接在聊天窗口内渲染视频标签并提供专门按钮下载
        bodyContainer.outerHTML = `
            <div class="video-wrapper">
                <video src="${url}" class="chat-video" controls playsinline preload="metadata"></video>
                <a href="${url}" download="${filename}" class="video-down-link">📥 下载视频 (${filename})</a>
            </div>`;
    } else if (isAud) {
        // 解析时长并渲染为微信同款短语音条
        let durationText = "语音 ''";
        if (filename.includes("_dur_")) {
            let parts = filename.split("_dur_");
            if (parts.length > 1) durationText = Math.ceil(parseFloat(parts[1])) + '"';
        }
        bodyContainer.outerHTML = `
            <div class="chat-audio-bubble" onclick="playChatAudio(this, '${url}')">
                <span class="audio-wave-icon">🔊</span>
                <span class="audio-duration">${durationText}</span>
            </div>`;
    } else {
        bodyContainer.outerHTML = `<a href="${url}" download="${filename}" class="chat-file">📁 ${filename}</a>`;
    }
    setTimeout(() => { document.getElementById('msg-box').scrollTop = document.getElementById('msg-box').scrollHeight; }, 50);
}

/* 微信风格点击播放语音核心函数 */
function playChatAudio(element, url) {
    const icon = element.querySelector('.audio-wave-icon');
    icon.innerText = "⚡"; 
    const audio = new Audio(url);
    audio.onended = () => { icon.innerText = "🔊"; };
    audio.onerror = () => { icon.innerText = "❌"; };
    audio.play();
}

/* 🎤 微信语音组件：按住说话、上划取消状态机系统 */
function initAudioRecordFeature() {
    const recordBtn = document.getElementById('btn-audio-record');
    const overlay = document.getElementById('audio-record-overlay');
    const tip = document.getElementById('audio-record-tip');
    
    if(!recordBtn) return;
    
    // 指针按下（支持鼠标和触屏）
    recordBtn.addEventListener('pointerdown', async (e) => {
        if (!dataChannel || dataChannel.readyState !== 'open') { return alert("直连尚未建立，无法录制语音！"); }
        e.preventDefault();
        recordBtn.setPointerCapture(e.pointerId);
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            audioStartTime = Date.now();
            isCancelDetected = false;
            isRecordingActive = true;
            recordStartY = e.clientY;
            
            // 设定兼容多端的录音格式
            let options = { mimeType: 'audio/webm' };
            if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) options = { mimeType: 'audio/ogg;codecs=opus' };
            
            mediaRecorder = new MediaRecorder(stream, options);
            mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunks.push(event.data); };
            
            mediaRecorder.onstop = () => {
                stream.getTracks().forEach(track => track.stop());
                if (isCancelDetected) { audioChunks = []; return; } // 取消发送
                
                const duration = (Date.now() - audioStartTime) / 1000;
                if (duration < 0.8) { alert("说话时间太短！"); return; }
                
                const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                // 将时长编码至文件名，便于接收端优雅提取
                const ext = mediaRecorder.mimeType.includes('ogg') ? '.opus' : '.webm';
                const audioFile = new File([audioBlob], `Audio_${Date.now()}_dur_${duration}${ext}`, { type: audioBlob.type });
                executeFileSending(audioFile);
            };
            
            mediaRecorder.start();
            recordBtn.classList.add('recording');
            overlay.style.display = 'flex';
            tip.innerText = "正在录音，上划取消";
            document.querySelector('.audio-record-box').classList.remove('cancel-state');
        } catch (err) {
            alert("无法获取麦克风权限: " + err.message);
        }
    });

    // 指针滑动侦测（检测是否上划）
    recordBtn.addEventListener('pointermove', (e) => {
        if (!isRecordingActive) return;
        let deltaY = recordStartY - e.clientY; // 往上滑动为正值
        if (deltaY > 50) {
            isCancelDetected = true;
            tip.innerText = "松开手指，取消发送";
            document.querySelector('.audio-record-box').classList.add('cancel-state');
        } else {
            isCancelDetected = false;
            tip.innerText = "正在录音，上划取消";
            document.querySelector('.audio-record-box').classList.remove('cancel-state');
        }
    });

    // 指针抬起发送
    recordBtn.addEventListener('pointerup', (e) => {
        if (!isRecordingActive) return;
        isRecordingActive = false;
        recordBtn.releasePointerCapture(e.pointerId);
        recordBtn.classList.remove('recording');
        overlay.style.display = 'none';
        if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); }
    });
    
    recordBtn.addEventListener('pointercancel', (e) => {
        isRecordingActive = false; isCancelDetected = true;
        recordBtn.classList.remove('recording'); overlay.style.display = 'none';
        if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); }
    });
}

function handlePaste(e) {
    const items = (e.clipboardData || window.clipboardData).items;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) { setupImagePreview(items[i].getAsFile(), "Paste_" + Date.now() + ".png"); e.preventDefault(); break; }
    }
}
async function takeScreenshot() {
    document.getElementById('screenshot-tip').style.display = 'block';
    try {
        const captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const videoTrack = captureStream.getVideoTracks()[0];
        const video = document.createElement('video'); video.srcObject = captureStream; video.autoplay = true;
        video.onloadedmetadata = () => {
            setTimeout(() => {
                const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height); videoTrack.stop(); document.getElementById('screenshot-tip').style.display = 'none';
                canvas.toBlob((blob) => { setupImagePreview(blob, "Capture_" + Date.now() + ".png"); }, 'image/png');
            }, 300); 
        };
    } catch (err) { document.getElementById('screenshot-tip').style.display = 'none'; }
}
function setupImagePreview(blob, filename) {
    clipboardFile = new File([blob], filename, { type: blob.type });
    document.getElementById('paste-preview-img').src = URL.createObjectURL(blob);
    document.getElementById('paste-preview-area').style.display = 'flex';
    document.getElementById('msg-input').placeholder = "图片已锁定，按回车直接发送..."; document.getElementById('msg-input').focus();
}
function clearImagePreview() { clipboardFile = null; document.getElementById('paste-preview-area').style.display = 'none'; document.getElementById('msg-input').placeholder = "输入消息或在此粘贴(Ctrl+V)图片..."; }
function sendClipboardImage() { if (!clipboardFile) return; executeFileSending(clipboardFile); clearImagePreview(); }

function jsonStr(action, obj) { return JSON.stringify({ action: action, ...obj }); }
function appendMessage(role, text) {
    const box = document.getElementById('msg-box'); box.innerHTML += `<div class="msg-row ${role}"><div class="bubble">${escapeHTML(text)}</div></div>`;
    box.scrollTop = box.scrollHeight;
}
function downloadFile(url, filename) { 
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
}
function escapeHTML(str) { return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); }