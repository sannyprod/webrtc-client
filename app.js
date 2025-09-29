// Конфигурация
const SERVER_URL = 'https://webrtc-signaling-server-production-f6b7.up.railway.app/';

// Элементы DOM
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const roomInput = document.getElementById('roomInput');
const statusEl = document.getElementById('status');
const roomStatusEl = document.getElementById('roomStatus');
const userCountEl = document.getElementById('userCount');
const leaveBtn = document.getElementById('leaveBtn');
const videoBtn = document.getElementById('videoBtn');
const audioBtn = document.getElementById('audioBtn');
const connectionStatusEl = document.getElementById('connectionStatus');

// Глобальные переменные
let socket;
let localStream;
let remoteStream;
let peerConnection;
let currentRoom = null;
let isVideoEnabled = true;
let isAudioEnabled = true;

// Переменные для теста микрофона
let isTestingMic = false;
let testStream = null;
let echoAudio = null;
let audioContext = null;
let analyser = null;
let microphone = null;
let javascriptNode = null;

// Конфигурация WebRTC
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ==================== ИНИЦИАЛИЗАЦИЯ ====================

document.addEventListener('DOMContentLoaded', function() {
    // Обработчики кнопок
    const testMicBtn = document.getElementById('testMicBtn');
    if (testMicBtn) {
        testMicBtn.addEventListener('click', testMicrophoneWithVisualizer);
    }
    
    // Инициализируем приложение
    init();
});

async function init() {
    await initMediaStream();
    initSocket();
}

// ==================== МЕДИА ПОТОК ====================

async function initMediaStream() {
    try {
        console.log('🔄 Запрашиваю доступ к медиаустройствам...');
        
        localStream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
        });
        
        console.log('✅ Медиапоток получен');
        localVideo.srcObject = localStream;
        updateStatus('Микрофон и камера подключены', 'connected');
        
        return localStream;
        
    } catch (error) {
        console.error('❌ Ошибка доступа к медиаустройствам:', error);
        
        let errorMessage = 'Неизвестная ошибка';
        switch(error.name) {
            case 'NotAllowedError':
                errorMessage = 'Доступ к камере/микрофону запрещен. Нажмите на значок 🔒 слева от адреса и разрешите доступ';
                break;
            case 'NotFoundError':
                errorMessage = 'Камера или микрофон не найдены';
                break;
            case 'NotReadableError':
                errorMessage = 'Камера или микрофон уже используются другим приложением';
                break;
            default:
                errorMessage = `Ошибка: ${error.message}`;
        }
        
        updateStatus(errorMessage, 'disconnected');
        return null;
    }
}

// ==================== SOCKET.IO ====================

function initSocket() {
    socket = io(SERVER_URL);
    
    socket.on('connect', () => {
        updateStatus('Подключен к серверу', 'connected');
    });
    
    socket.on('disconnect', () => {
        updateStatus('Отключен от сервера', 'disconnected');
    });
    
    socket.on('room-created', (roomId) => {
        currentRoom = roomId;
        roomStatusEl.textContent = roomId;
        updateStatus(`Комната создана: ${roomId}`, 'connected');
        leaveBtn.disabled = false;
    });
    
    socket.on('room-joined', (data) => {
        currentRoom = data.roomId;
        roomStatusEl.textContent = data.roomId;
        updateStatus(`Присоединились к комнате: ${data.roomId}`, 'connected');
        leaveBtn.disabled = false;
        
        // Если в комнате есть другие пользователи, устанавливаем соединение
        if (data.users && data.users.length > 0) {
            data.users.forEach(userId => {
                createPeerConnection(true);
            });
        }
    });
    
    socket.on('room-not-found', (roomId) => {
        updateStatus(`Комната ${roomId} не найдена`, 'disconnected');
    });
    
    socket.on('user-joined', async (data) => {
        console.log(`👤 Пользователь присоединился: ${data.userId}`);
        updateStatus(`Пользователь присоединился: ${data.userId}`, 'connected');
        
        // Создаем peer connection как инициатор
        await createPeerConnection(true);
    });
    
    socket.on('user-left', (userId) => {
        console.log(`👤 Пользователь покинул: ${userId}`);
        updateStatus(`Пользователь покинул: ${userId}`, 'connected');
        
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        remoteVideo.srcObject = null;
    });
    
    // WebRTC события
    socket.on('webrtc-offer', async (data) => {
        await handleOffer(data);
    });
    
    socket.on('webrtc-answer', async (data) => {
        await handleAnswer(data);
    });
    
    socket.on('webrtc-ice-candidate', async (data) => {
        await handleIceCandidate(data);
    });
    
    // Статистика
    socket.on('stats-update', (data) => {
        userCountEl.textContent = data.users;
    });
}

// ==================== WEBRTC ====================

async function createPeerConnection(isInitiator = false) {
    if (peerConnection) {
        console.log('⚠️ Peer connection уже существует, закрываю старый');
        peerConnection.close();
    }
    
    // Убедимся что localStream существует
    if (!localStream) {
        console.log('🔄 localStream не найден, инициализирую...');
        await initMediaStream();
    }
    
    console.log('🔄 Создаю peer connection...');
    peerConnection = new RTCPeerConnection(configuration);
    
    // Добавляем локальные треки
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    // Обработка входящего потока
    peerConnection.ontrack = (event) => {
        console.log('📹 Получен удаленный поток');
        remoteStream = event.streams[0];
        remoteVideo.srcObject = remoteStream;
        updateStatus('Установлено P2P соединение', 'connected');
    };
    
    // Обработка ICE кандидатов
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && currentRoom) {
            socket.emit('webrtc-ice-candidate', {
                candidate: event.candidate,
                target: getOtherUsers()
            });
        }
    };
    
    // Отслеживание состояний
    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        connectionStatusEl.textContent = `ICE: ${state}`;
        console.log(`ICE состояние: ${state}`);
    };
    
    peerConnection.onsignalingstatechange = () => {
        console.log(`Signaling состояние: ${peerConnection.signalingState}`);
    };
    
    // Если мы инициатор, создаем оффер
    if (isInitiator) {
        setTimeout(() => {
            createOffer();
        }, 500);
    }
    
    return peerConnection;
}

async function createOffer() {
    try {
        if (!peerConnection) {
            console.error('❌ peerConnection не создан');
            return;
        }
        
        console.log('📤 Создаю оффер...');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('webrtc-offer', {
            offer: offer,
            target: getOtherUsers()
        });
        
        console.log('✅ Оффер создан и отправлен');
    } catch (error) {
        console.error('❌ Ошибка создания оффера:', error);
    }
}

async function handleOffer(data) {
    console.log('📨 Получен оффер от:', data.from);
    
    if (!peerConnection) {
        await createPeerConnection(false);
    }
    
    try {
        await peerConnection.setRemoteDescription(data.offer);
        console.log('✅ Remote description (offer) установлен');
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('webrtc-answer', {
            answer: answer,
            target: data.from
        });
        
        console.log('📤 Ответ отправлен');
    } catch (error) {
        console.error('❌ Ошибка обработки оффера:', error);
    }
}

async function handleAnswer(data) {
    console.log('📨 Получен ответ от:', data.from);
    
    try {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(data.answer);
            console.log('✅ Remote description (answer) установлен');
        }
    } catch (error) {
        console.error('❌ Ошибка обработки ответа:', error);
    }
}

async function handleIceCandidate(data) {
    try {
        if (peerConnection && data.candidate) {
            await peerConnection.addIceCandidate(data.candidate);
            console.log('✅ ICE кандидат добавлен');
        }
    } catch (error) {
        console.error('❌ Ошибка добавления ICE кандидата:', error);
    }
}

// ==================== УПРАВЛЕНИЕ КОМНАТАМИ ====================

async function createRoom() {
    const roomId = Math.random().toString(36).substring(2, 8);
    roomInput.value = roomId;
    
    if (!localStream) {
        await initMediaStream();
    }
    
    socket.emit('create-room', roomId);
}

async function joinRoom() {
    const roomId = roomInput.value.trim();
    if (roomId) {
        if (!localStream) {
            await initMediaStream();
        }
        
        socket.emit('join-room', roomId);
    } else {
        alert('Введите ID комнаты');
    }
}

function leaveRoom() {
    if (currentRoom) {
        socket.emit('leave-room', currentRoom);
        currentRoom = null;
        roomStatusEl.textContent = 'Нет';
        leaveBtn.disabled = true;
        updateStatus('Покинули комнату', 'disconnected');
        
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        remoteVideo.srcObject = null;
    }
}

// ==================== УПРАВЛЕНИЕ МЕДИА ====================

function toggleVideo() {
    if (localStream && localStream.getVideoTracks().length > 0) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            isVideoEnabled = videoTrack.enabled;
            videoBtn.textContent = isVideoEnabled ? 'Выключить видео' : 'Включить видео';
        }
    }
}

function toggleAudio() {
    if (localStream && localStream.getAudioTracks().length > 0) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            isAudioEnabled = audioTrack.enabled;
            audioBtn.textContent = isAudioEnabled ? 'Выключить audio' : 'Включить audio';
        }
    }
}

// ==================== ТЕСТ МИКРОФОНА ====================

async function testMicrophoneWithVisualizer() {
    if (!isTestingMic) {
        try {
            testStream = await navigator.mediaDevices.getUserMedia({ 
                audio: true, 
                video: false 
            });
            
            // Показываем панель визуализации
            document.getElementById('micTestPanel').style.display = 'block';
            
            // Создаем AudioContext для анализа звука
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            microphone = audioContext.createMediaStreamSource(testStream);
            javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);
            
            analyser.smoothingTimeConstant = 0.8;
            analyser.fftSize = 1024;
            
            microphone.connect(analyser);
            analyser.connect(javascriptNode);
            javascriptNode.connect(audioContext.destination);
            
            // Анализируем уровень звука
            javascriptNode.onaudioprocess = function() {
                const array = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(array);
                
                let values = 0;
                for (let i = 0; i < array.length; i++) {
                    values += array[i];
                }
                
                const average = values / array.length;
                const percentage = Math.min(100, (average / 256) * 100);
                
                document.getElementById('volumeLevel').style.width = percentage + '%';
                
                const volumeLevel = document.getElementById('volumeLevel');
                if (percentage < 30) {
                    volumeLevel.style.background = '#28a745';
                } else if (percentage < 70) {
                    volumeLevel.style.background = '#ffc107';
                } else {
                    volumeLevel.style.background = '#dc3545';
                }
            };
            
            // Воспроизводим эхо
            echoAudio = document.getElementById('echoAudio');
            echoAudio.srcObject = testStream;
            await echoAudio.play();
            
            isTestingMic = true;
            updateStatus('Тест микрофона активен - говорите и смотрите уровень', 'connected');
            
        } catch (error) {
            console.error('Ошибка:', error);
            updateStatus(`Ошибка: ${error.message}`, 'disconnected');
        }
    } else {
        stopMicrophoneTest();
    }
}

function stopMicrophoneTest() {
    if (testStream) {
        testStream.getTracks().forEach(track => track.stop());
        testStream = null;
    }
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    if (echoAudio) {
        echoAudio.pause();
        echoAudio.srcObject = null;
    }
    
    document.getElementById('micTestPanel').style.display = 'none';
    isTestingMic = false;
    
    updateStatus('Тест микрофона завершен', 'disconnected');
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

function getOtherUsers() {
    return currentRoom;
}

function updateStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = type;
    console.log(`Status: ${message}`);
}

// Сделаем функции глобальными для HTML onclick
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.leaveRoom = leaveRoom;
window.toggleVideo = toggleVideo;
window.toggleAudio = toggleAudio;
window.stopMicrophoneTest = stopMicrophoneTest;