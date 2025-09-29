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
let isOfferer = false;

// Переменные для теста микрофона
let isTestingMic = false;
let testStream = null;
let echoAudio = null;

// Конфигурация WebRTC
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};


// ==================== ИНИЦИАЛИЗАЦИЯ ====================

document.addEventListener('DOMContentLoaded', function () {
    const testMicBtn = document.getElementById('testMicBtn');
    if (testMicBtn) {
        testMicBtn.addEventListener('click', testMicrophoneWithVisualizer);
    }

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
            video: false,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 2,
                sampleRate: 44100,
                latency: 0.01
            }
        });

        console.log('✅ Медиапоток получен');
        console.log('🎤 Аудио треки:', localStream.getAudioTracks());

        // Проверяем аудио треки
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            console.log('🔊 Аудио трек найден, enabled:', audioTracks[0].enabled);
            audioTracks[0].enabled = true; // Принудительно включаем
        }

        localVideo.srcObject = localStream;
        updateStatus('Микрофон и камера подключены', 'connected');

        return localStream;

    } catch (error) {
        console.error('❌ Ошибка доступа к медиаустройствам:', error);

        let errorMessage = 'Неизвестная ошибка';
        switch (error.name) {
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
        isOfferer = true; // Создатель комнаты будет офферером
    });

    socket.on('room-joined', (data) => {
        currentRoom = data.roomId;
        roomStatusEl.textContent = data.roomId;
        updateStatus(`Присоединились к комнате: ${data.roomId}`, 'connected');
        leaveBtn.disabled = false;
        isOfferer = false; // Присоединившийся будет ансвером
    });

    socket.on('room-not-found', (roomId) => {
        updateStatus(`Комната ${roomId} не найдена`, 'disconnected');
    });

    socket.on('user-joined', async (data) => {
        console.log(`👤 Пользователь присоединился: ${data.userId}`);
        updateStatus(`Пользователь присоединился: ${data.userId}`, 'connected');

        // Если мы создатель комнаты, инициируем соединение
        if (isOfferer) {
            await createPeerConnection();
            await createOffer();
        }
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
        console.log('📨 Получен оффер от:', data.from);
        await handleOffer(data);
    });

    socket.on('webrtc-answer', async (data) => {
        console.log('📨 Получен ответ от:', data.from);
        await handleAnswer(data);
    });

    socket.on('webrtc-ice-candidate', async (data) => {
        console.log('📨 Получен ICE кандидат от:', data.from);
        await handleIceCandidate(data);
    });

    // Статистика
    socket.on('stats-update', (data) => {
        userCountEl.textContent = data.users;
    });
}

// ==================== WEBRTC - ПЕРЕПИСАННАЯ ЛОГИКА ====================

async function createPeerConnection() {
    // Закрываем существующее соединение
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
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
        console.log('📹 Получен удаленный поток:', event.streams[0]);
        remoteStream = event.streams[0];
        remoteVideo.srcObject = remoteStream;

        // Принудительно включаем звук на удаленном видео
        remoteVideo.volume = 1.0;
        remoteVideo.muted = false;

        // Проверяем аудио треки
        const audioTracks = remoteStream.getAudioTracks();
        console.log('🔊 Удаленные аудио треки:', audioTracks);
        if (audioTracks.length > 0) {
            audioTracks[0].enabled = true;
        }

        updateStatus('Установлено P2P соединение', 'connected');
    };

    // Обработка ICE кандидатов
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && currentRoom) {
            console.log('📤 Отправляю ICE кандидат');
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

        if (state === 'connected' || state === 'completed') {
            updateStatus('P2P соединение установлено', 'connected');
        } else if (state === 'failed' || state === 'disconnected') {
            console.error('❌ ICE соединение разорвано');
            updateStatus('Проблемы с соединением', 'disconnected');
            // Попробуем пересоздать соединение
            setTimeout(() => {
                if (currentRoom && peerConnection) {
                    console.log('🔄 Пересоздаю соединение...');
                    createPeerConnection().then(() => {
                        if (isOfferer) {
                            createOffer();
                        }
                    });
                }
            }, 2000);
        }
    };


    peerConnection.onsignalingstatechange = () => {
        console.log(`Signaling состояние: ${peerConnection.signalingState}`);
    };

    peerConnection.onconnectionstatechange = () => {
        console.log(`Connection состояние: ${peerConnection.connectionState}`);
    };

    return peerConnection;
}

async function createOffer() {
    try {
        if (!peerConnection) {
            await createPeerConnection();
        }

        console.log('📤 Создаю оффер...');
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });

        console.log('✅ Оффер создан, устанавливаю local description');
        await peerConnection.setLocalDescription(offer);

        console.log('📤 Отправляю оффер...');
        socket.emit('webrtc-offer', {
            offer: offer,
            target: getOtherUsers()
        });

    } catch (error) {
        console.error('❌ Ошибка создания оффера:', error);
    }
}

async function handleOffer(data) {
    try {
        console.log('🔄 Обрабатываю оффер...');

        if (!peerConnection) {
            await createPeerConnection();
        }

        // Проверяем текущее состояние
        if (peerConnection.signalingState !== 'stable') {
            console.log('⚠️ Signaling state не stable, жду...');
            setTimeout(() => handleOffer(data), 1000);
            return;
        }

        console.log('✅ Устанавливаю remote description (offer)...');
        await peerConnection.setRemoteDescription(data.offer);

        console.log('📤 Создаю ответ...');
        const answer = await peerConnection.createAnswer();

        console.log('✅ Устанавливаю local description (answer)...');
        await peerConnection.setLocalDescription(answer);

        console.log('📤 Отправляю ответ...');
        socket.emit('webrtc-answer', {
            answer: answer,
            target: data.from
        });

    } catch (error) {
        console.error('❌ Ошибка обработки оффера:', error);
    }
}

async function handleAnswer(data) {
    try {
        if (!peerConnection) {
            console.error('❌ Peer connection не существует');
            return;
        }

        // Проверяем что мы в состоянии 'have-local-offer'
        if (peerConnection.signalingState !== 'have-local-offer') {
            console.log('⚠️ Неправильное состояние для answer:', peerConnection.signalingState);
            return;
        }

        console.log('✅ Устанавливаю remote description (answer)...');
        await peerConnection.setRemoteDescription(data.answer);

    } catch (error) {
        console.error('❌ Ошибка обработки ответа:', error);
    }
}

async function handleIceCandidate(data) {
    try {
        if (peerConnection && data.candidate) {
            console.log('✅ Добавляю ICE кандидат...');
            await peerConnection.addIceCandidate(data.candidate);
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

            // Воспроизводим эхо
            echoAudio = document.getElementById('echoAudio');
            echoAudio.srcObject = testStream;
            await echoAudio.play();

            isTestingMic = true;
            document.getElementById('testMicBtn').textContent = '🔇 Выключить эхо';
            document.getElementById('testMicBtn').style.background = '#dc3545';
            updateStatus('Эхо включено - говорите в микрофон', 'connected');

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

    if (echoAudio) {
        echoAudio.pause();
        echoAudio.srcObject = null;
    }

    isTestingMic = false;
    document.getElementById('testMicBtn').textContent = '🎤 Тест микрофона';
    document.getElementById('testMicBtn').style.background = '#28a745';
    updateStatus('Эхо выключено', 'disconnected');
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
