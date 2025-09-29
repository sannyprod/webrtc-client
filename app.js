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

// Конфигурация WebRTC
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Инициализация при загрузке
async function init() {
    await initMediaStream();
    initSocket();
}

// Инициализация медиапотока
async function initMediaStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
        });
        localVideo.srcObject = localStream;
        updateStatus('Медиаустройства подключены', 'connected');
    } catch (error) {
        console.error('Ошибка доступа к медиаустройствам:', error);
        updateStatus('Ошибка доступа к камере/микрофону', 'disconnected');
    }
}

// Инициализация Socket.io
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
                createPeerConnection();
            });
        }
    });
    
    socket.on('room-not-found', (roomId) => {
        updateStatus(`Комната ${roomId} не найдена`, 'disconnected');
    });
    
    socket.on('user-joined', (data) => {
        updateStatus(`Пользователь присоединился: ${data.userId}`, 'connected');
        createPeerConnection();
    });
    
    socket.on('user-left', (userId) => {
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

// Создание комнаты
function createRoom() {
    const roomId = Math.random().toString(36).substring(2, 8);
    roomInput.value = roomId;
    socket.emit('create-room', roomId);
}

// Присоединение к комнате
function joinRoom() {
    const roomId = roomInput.value.trim();
    if (roomId) {
        socket.emit('join-room', roomId);
    } else {
        alert('Введите ID комнаты');
    }
}

// Покинуть комнату
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

// Создание Peer Connection
function createPeerConnection() {
    if (peerConnection) {
        return; // Уже создано
    }
    
    peerConnection = new RTCPeerConnection(configuration);
    
    // Добавляем локальные треки
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });
    
    // Обработка входящего потока
    peerConnection.ontrack = (event) => {
        remoteStream = event.streams[0];
        remoteVideo.srcObject = remoteStream;
        updateStatus('Установлено P2P соединение', 'connected');
    };
    
    // Обработка ICE кандидатов
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', {
                candidate: event.candidate,
                target: getOtherUsers()
            });
        }
    };
    
    peerConnection.oniceconnectionstatechange = () => {
        connectionStatusEl.textContent = `ICE состояние: ${peerConnection.iceConnectionState}`;
    };
    
    // Создаем оффер для нового соединения
    createOffer();
}

// Создание оффера
async function createOffer() {
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('webrtc-offer', {
            offer: offer,
            target: getOtherUsers()
        });
    } catch (error) {
        console.error('Ошибка создания оффера:', error);
    }
}

// Обработка входящего оффера
async function handleOffer(data) {
    if (!peerConnection) {
        createPeerConnection();
    }
    
    try {
        await peerConnection.setRemoteDescription(data.offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('webrtc-answer', {
            answer: answer,
            target: data.from
        });
    } catch (error) {
        console.error('Ошибка обработки оффера:', error);
    }
}

// Обработка входящего ответа
async function handleAnswer(data) {
    try {
        await peerConnection.setRemoteDescription(data.answer);
    } catch (error) {
        console.error('Ошибка обработки ответа:', error);
    }
}

// Обработка ICE кандидата
async function handleIceCandidate(data) {
    try {
        await peerConnection.addIceCandidate(data.candidate);
    } catch (error) {
        console.error('Ошибка добавления ICE кандидата:', error);
    }
}

// Получение других пользователей в комнате
function getOtherUsers() {
    // В реальном приложении здесь была бы логика получения списка пользователей
    // Пока просто broadcast всем в комнате
    return currentRoom;
}

// Управление видео/аудио
function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            isVideoEnabled = videoTrack.enabled;
            videoBtn.textContent = isVideoEnabled ? 'Выключить видео' : 'Включить видео';
        }
    }
}

function toggleAudio() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            isAudioEnabled = audioTrack.enabled;
            audioBtn.textContent = isAudioEnabled ? 'Выключить audio' : 'Включить audio';
        }
    }
}

// Обновление статуса
function updateStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = type;
    console.log(`Status: ${message}`);
}

async function requestMediaPermissions() {
    try {
        // Проверяем доступность API
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            updateStatus('Ваш браузер не поддерживает доступ к медиаустройствам', 'disconnected');
            return;
        }
        
        // Запрашиваем только аудио для теста
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStream.getTracks().forEach(track => track.stop());
        
        updateStatus('Доступ к микрофону разрешен. Теперь запрашиваем видео...', 'connected');
        
        // Теперь запрашиваем полный доступ
        await initMediaStream();
        
    } catch (error) {
        console.error('Ошибка разрешения:', error);
        updateStatus('Разрешите доступ к микрофону в настройках браузера', 'disconnected');
    }
}

// Запуск при загрузке страницы
window.onload = init;