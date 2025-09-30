// Конфигурация
const SERVER_URL = 'https://webrtc-signaling-server-production-f6b7.up.railway.app/';

// Global variables
let socket = null;
let localStream = null;
let peers = {};
let currentCall = null;
let username = '';

// DOM elements
const loginSection = document.getElementById('login-section');
const chatSection = document.getElementById('chat-section');
const statusDiv = document.getElementById('status');
const usersContainer = document.getElementById('users-container');
const usersCount = document.getElementById('users-count');
const incomingCallDiv = document.getElementById('incoming-call');
const callerNameSpan = document.getElementById('caller-name');
const callStatusDiv = document.getElementById('call-status');
const startAudioBtn = document.getElementById('start-audio-btn');
const endCallBtn = document.getElementById('end-call-btn');

function joinChat() {
    username = document.getElementById('username').value.trim();
    if (!username) {
        alert('Please enter your name');
        return;
    }

    connectToServer();
}

function connectToServer() {
    socket = io(SERVER_URL);

    socket.on('connect', () => {
        updateStatus('Connected to server', 'connected');
        socket.emit('register', { name: username });
    });

    socket.on('registered', (data) => {
        console.log('Registered with ID:', data.id);
        showChatSection();
        updateUsersList(data.users);
    });

    socket.on('users-list', (users) => {
        updateUsersList(users);
    });

    socket.on('user-joined', (user) => {
        addUser(user);
    });

    socket.on('user-left', (user) => {
        removeUser(user.id);
        if (peers[user.id]) {
            peers[user.id].destroy();
            delete peers[user.id];
        }
    });

    socket.on('offer', async (data) => {
        console.log('Received offer from:', data.from);
        await handleOffer(data);
    });

    socket.on('answer', (data) => {
        console.log('Received answer from:', data.from);
        if (peers[data.from]) {
            peers[data.from].signal(data.answer);
        }
    });

    socket.on('ice-candidate', (data) => {
        if (peers[data.from]) {
            peers[data.from].signal(data.candidate);
        }
    });

    socket.on('incoming-call', (data) => {
        showIncomingCall(data.from, data.fromName);
    });

    socket.on('call-rejected', (data) => {
        alert('Call was rejected');
        resetCallUI();
    });

    socket.on('call-ended', (data) => {
        alert('Call ended');
        resetCallUI();
        if (peers[data.from]) {
            peers[data.from].destroy();
            delete peers[data.from];
        }
    });

    socket.on('disconnect', () => {
        updateStatus('Disconnected from server', 'disconnected');
    });
}

function updateStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
}

function showChatSection() {
    loginSection.style.display = 'none';
    chatSection.style.display = 'block';
}

function updateUsersList(users) {
    usersContainer.innerHTML = '';
    users.forEach(user => addUser(user));
    // Add self user
    addUser({ id: socket.id, name: username + ' (You)' }, true);
    usersCount.textContent = `(${users.length + 1})`;
}

function addUser(user, isSelf = false) {
    const userCard = document.createElement('div');
    userCard.className = `user-card ${isSelf ? 'self' : ''}`;
    userCard.id = `user-${user.id}`;
    userCard.innerHTML = `
                <h3>${user.name}</h3>
                ${!isSelf ? `<button onclick="callUser('${user.id}')" class="btn btn-success">Call</button>` : ''}
            `;
    usersContainer.appendChild(userCard);
}

function removeUser(userId) {
    const userElement = document.getElementById(`user-${userId}`);
    if (userElement) {
        userElement.remove();
    }
}

async function startAudio() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

        startAudioBtn.style.display = 'none';
        endCallBtn.style.display = 'inline-block';
        callStatusDiv.innerHTML = 'Audio started <span class="audio-indicator"></span>';

        console.log('Audio stream obtained');
    } catch (error) {
        console.error('Error accessing microphone:', error);
        alert('Error accessing microphone. Please check permissions.');
    }
}

function callUser(targetUserId) {
    if (!localStream) {
        alert('Please start audio first');
        return;
    }

    currentCall = targetUserId;
    createPeer(targetUserId, true);
}

function createPeer(targetUserId, initiator = false) {
    const peer = new SimplePeer({
        initiator: initiator,
        trickle: false,
        stream: localStream,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ]
        }
    });

    peer.on('signal', (data) => {
        if (data.type === 'offer') {
            socket.emit('offer', { target: targetUserId, offer: data });
        } else if (data.type === 'answer') {
            socket.emit('answer', { target: targetUserId, answer: data });
        } else if (data.candidate) {
            socket.emit('ice-candidate', { target: targetUserId, candidate: data });
        }
    });

    peer.on('stream', (remoteStream) => {
        console.log('Received remote stream');
        // Create audio element for remote stream
        const audio = document.createElement('audio');
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audio.controls = false;
        document.body.appendChild(audio);
    });

    peer.on('connect', () => {
        console.log('Peer connected');
        callStatusDiv.innerHTML = `In call with user <span class="audio-indicator"></span>`;
    });

    peer.on('close', () => {
        console.log('Peer connection closed');
        resetCallUI();
    });

    peer.on('error', (err) => {
        console.error('Peer error:', err);
        resetCallUI();
    });

    peers[targetUserId] = peer;
    return peer;
}

async function handleOffer(data) {
    if (!localStream) {
        await startAudio();
    }

    const peer = createPeer(data.from, false);
    peer.signal(data.offer);
}

function showIncomingCall(fromUserId, fromUserName) {
    callerNameSpan.textContent = fromUserName;
    incomingCallDiv.style.display = 'block';
    currentCall = fromUserId;
}

function acceptCall() {
    incomingCallDiv.style.display = 'none';
    endCallBtn.style.display = 'inline-block';
    callStatusDiv.innerHTML = `In call <span class="audio-indicator"></span>`;
}

function rejectCall() {
    socket.emit('reject-call', { target: currentCall });
    incomingCallDiv.style.display = 'none';
    currentCall = null;
}

function endCall() {
    if (currentCall) {
        socket.emit('end-call', { target: currentCall });

        if (peers[currentCall]) {
            peers[currentCall].destroy();
            delete peers[currentCall];
        }
    }

    resetCallUI();

    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
}

function resetCallUI() {
    currentCall = null;
    startAudioBtn.style.display = 'inline-block';
    endCallBtn.style.display = 'none';
    callStatusDiv.textContent = '';
    incomingCallDiv.style.display = 'none';
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }

    Object.values(peers).forEach(peer => peer.destroy());

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
});