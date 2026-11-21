import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getDatabase, ref, onValue, set, remove, onChildAdded, off, get } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBEE6iwOKTYrepZMnkdqidm6nVvnqi3LhE",
    authDomain: "personalmonitor-fab80.firebaseapp.com",
    databaseURL: "https://personalmonitor-fab80-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "personalmonitor-fab80",
    storageBucket: "personalmonitor-fab80.firebasestorage.app",
    messagingSenderId: "177121615044",
    appId: "1:177121615044:web:59801c642c321f43e7fd91"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const btnLogout = document.getElementById('btn-logout');

const btnCamBack = document.getElementById('btn-cam-back');
const btnCamFront = document.getElementById('btn-cam-front');
const btnAudioOnly = document.getElementById('btn-audio-only');
const btnScreenMirror = document.getElementById('btn-screen-mirror');
const btnStopStream = document.getElementById('btn-stop-stream');
const streamContainer = document.getElementById('stream-container');
const remoteVideo = document.getElementById('remote-video');
const streamStatus = document.getElementById('stream-status');

const allCtrlButtons = [btnCamBack, btnCamFront, btnAudioOnly, btnScreenMirror];

let map = null;
let marker = null;
let currentUserUid = null;
let pc = null;
let answerRef = null;
let errorRef = null;
let androidCandRef = null;

function initMap(lat = -7.4471983, lng = 112.685231) {
    if (map !== null) return;
    map = L.map('map').setView([lat, lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    marker = L.marker([lat, lng]).addTo(map).bindPopup('Lokasi Perangkat').openPopup();
}

async function startRemoteStream(mode, activeBtn) {
    if (!currentUserUid) return;
    await stopRemoteStream(false);

    allCtrlButtons.forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
    btnStopStream.style.display = 'block';
    streamContainer.style.display = 'block';
    streamStatus.style.color = '#38bdf8';
    streamStatus.textContent = 'Mengambil konfigurasi jaringan & meminta sinyal HP...';

    const webrtcBase = `users/${currentUserUid}/webrtc`;
    await remove(ref(db, webrtcBase));

    // Ambil konfigurasi TURN secara dinamis dari Firebase
    const turnSnap = await get(ref(db, `users/${currentUserUid}/turn_config`));
    const turnData = turnSnap.val() || {};

    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:free.expressturn.com:3478' }
    ];

    if (turnData.username && turnData.password) {
        iceServers.push(
            {
                urls: turnData.url_udp || 'turn:free.expressturn.com:3478?transport=udp',
                username: turnData.username,
                credential: turnData.password
            },
            {
                urls: turnData.url_tcp || 'turn:free.expressturn.com:3478?transport=tcp',
                username: turnData.username,
                credential: turnData.password
            }
        );
    }

    pc = new RTCPeerConnection({ iceServers });

    let inboundStream = new MediaStream();
    pc.ontrack = (event) => {
        inboundStream.addTrack(event.track);
        remoteVideo.srcObject = inboundStream;
        remoteVideo.muted = false;

        remoteVideo.play().catch(e => {
            console.warn('Autoplay dengan suara diblokir, fallback muted:', e);
            remoteVideo.muted = true;
            remoteVideo.play();
        });

        streamStatus.style.color = '#22c55e';
        const labels = {
            camera_back: 'Live: Kamera Belakang Terhubung',
            camera_front: 'Live: Kamera Depan Terhubung',
            audio_only: 'Live: One-Way Audio Aktif',
            screen_mirror: 'Live: Screen Mirroring Aktif'
        };
        streamStatus.textContent = labels[mode] || 'Live: Terhubung';
    };

    pc.oniceconnectionstatechange = () => {
        if (!pc) return;
        console.log('ICE State:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            streamStatus.style.color = '#ef4444';
            streamStatus.textContent = 'Koneksi stream terputus (' + pc.iceConnectionState + ').';
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            set(ref(db, `${webrtcBase}/web_candidates/${Date.now()}_${Math.floor(Math.random()*1000)}`), {
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                candidate: event.candidate.candidate
            });
        }
    };

    pc.addTransceiver('audio', { direction: 'recvonly' });
    if (mode !== 'audio_only') {
        pc.addTransceiver('video', { direction: 'recvonly' });
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await set(ref(db, `${webrtcBase}/command`), {
        action: mode,
        sdp: offer.sdp,
        timestamp: Date.now()
    });

    errorRef = ref(db, `${webrtcBase}/error`);
    onValue(errorRef, (snapshot) => {
        const errMsg = snapshot.val();
        if (errMsg) {
            streamStatus.style.color = '#ef4444';
            streamStatus.textContent = errMsg;
        }
    });

    answerRef = ref(db, `${webrtcBase}/answer`);
    onValue(answerRef, async (snapshot) => {
        const ans = snapshot.val();
        if (ans && ans.sdp && pc && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: ans.sdp
            }));
        }
    });

    androidCandRef = ref(db, `${webrtcBase}/android_candidates`);
    onChildAdded(androidCandRef, async (snapshot) => {
        const cand = snapshot.val();
        if (cand && cand.candidate && pc) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (e) {
                console.error('ICE Error:', e);
            }
        }
    });
}

async function stopRemoteStream(notifyAndroid = true) {
    if (answerRef) { off(answerRef); answerRef = null; }
    if (errorRef) { off(errorRef); errorRef = null; }
    if (androidCandRef) { off(androidCandRef); androidCandRef = null; }
    if (pc) {
        pc.close();
        pc = null;
    }
    if (remoteVideo.srcObject) {
        remoteVideo.srcObject.getTracks().forEach(t => t.stop());
        remoteVideo.srcObject = null;
    }
    allCtrlButtons.forEach(b => b.classList.remove('active'));
    btnStopStream.style.display = 'none';
    streamContainer.style.display = 'none';

    if (notifyAndroid && currentUserUid) {
        await remove(ref(db, `users/${currentUserUid}/webrtc`));
    }
}

btnCamBack.addEventListener('click', () => startRemoteStream('camera_back', btnCamBack));
btnCamFront.addEventListener('click', () => startRemoteStream('camera_front', btnCamFront));
btnAudioOnly.addEventListener('click', () => startRemoteStream('audio_only', btnAudioOnly));
btnScreenMirror.addEventListener('click', () => startRemoteStream('screen_mirror', btnScreenMirror));
btnStopStream.addEventListener('click', () => stopRemoteStream(true));

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.style.display = 'none';
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
        loginError.textContent = "Login gagal: " + err.message;
        loginError.style.display = 'block';
    }
});

btnLogout.addEventListener('click', async () => {
    await stopRemoteStream(true);
    signOut(auth);
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUserUid = user.uid;
        loginScreen.style.display = 'none';
        dashboardScreen.style.display = 'flex';
        document.getElementById('user-email-display').textContent = user.email;

        initMap();
        setTimeout(() => { if (map) map.invalidateSize(); }, 200);

        const statusRef = ref(db, 'users/' + user.uid + '/device_status');
        onValue(statusRef, (snapshot) => {
            const data = snapshot.val();
            if (!data) return;

            document.getElementById('conn-dot').classList.add('online');
            document.getElementById('sync-status').textContent = 'Terhubung';
            document.getElementById('sync-status').style.color = '#22c55e';

            const batEl = document.getElementById('bat-val');
            batEl.textContent = data.battery + '%';
            batEl.style.color = data.battery <= 20 ? '#ef4444' : '#22c55e';

            const lat = data.latitude;
            const lng = data.longitude;
            document.getElementById('lat-val').textContent = lat.toFixed(6);
            document.getElementById('lng-val').textContent = lng.toFixed(6);

            if (data.last_updated) {
                const date = new Date(data.last_updated);
                document.getElementById('time-val').textContent = date.toLocaleTimeString('id-ID') + ' WIB';
            }

            document.getElementById('gmaps-link').href = `https://www.google.com/maps?q=${lat},${lng}`;

            if (map && marker) {
                const newLatLng = [lat, lng];
                marker.setLatLng(newLatLng);
                map.panTo(newLatLng);
            }
        });
    } else {
        currentUserUid = null;
        loginScreen.style.display = 'flex';
        dashboardScreen.style.display = 'none';
    }
});
