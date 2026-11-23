const firebaseConfig = {
  apiKey: "AIzaSyDV0rV5BQUugkFSViXrmvkXnC1OtgAlDAo",
  authDomain: "personalmonitor-fab80.firebaseapp.com",
  databaseURL: "https://personalmonitor-fab80-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "personalmonitor-fab80",
  storageBucket: "personalmonitor-fab80.firebasestorage.app",
  messagingSenderId: "177121615044",
  appId: "1:177121615044:web:7fd7c333f601d14fe7fd91"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

let currentUid = null;
let map = null;
let marker = null;
let peerConnection = null;
let activeTurnUser = "";
let activeTurnPass = "";

// Elemen UI
const loginSection = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const loginError = document.getElementById("login-error");

document.getElementById("btn-login").addEventListener("click", () => {
  const email = document.getElementById("login-email").value.trim();
  const pass = document.getElementById("login-password").value.trim();
  loginError.textContent = "";

  auth.signInWithEmailAndPassword(email, pass)
    .catch((err) => {
      loginError.textContent = "Gagal masuk: " + err.message;
    });
});

document.getElementById("btn-logout").addEventListener("click", () => {
  stopRemoteStream();
  auth.signOut();
});

auth.onAuthStateChanged((user) => {
  if (user) {
    currentUid = user.uid;
    document.getElementById("user-email-display").textContent = user.email;
    loginSection.classList.add("hidden");
    dashboardSection.classList.remove("hidden");
    initMap();
    listenDeviceStatus(user.uid);
    initTurnSettings();
  } else {
    currentUid = null;
    loginSection.classList.remove("hidden");
    dashboardSection.classList.add("hidden");
  }
});

function initMap() {
  if (map) return;
  map = L.map("map").setView([-7.2575, 112.7521], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

function listenDeviceStatus(uid) {
  db.ref(`users/${uid}/device_status`).on("value", (snap) => {
    const data = snap.val();
    if (!data) return;

    const onlineEl = document.getElementById("stat-online");
    if (data.online) {
      onlineEl.textContent = "Online";
      onlineEl.className = "stat-value badge-online";
    } else {
      onlineEl.textContent = "Offline";
      onlineEl.className = "stat-value badge-offline";
    }

    document.getElementById("stat-battery").textContent =
      data.battery !== undefined ? `${data.battery}%` : "-";

    if (data.last_seen) {
      document.getElementById("stat-lastseen").textContent =
        new Date(data.last_seen).toLocaleString("id-ID");
    }

    if (data.latitude && data.longitude) {
      const lat = data.latitude;
      const lng = data.longitude;
      document.getElementById("stat-coords").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

      if (map) {
        if (!marker) {
          marker = L.marker([lat, lng]).addTo(map);
        } else {
          marker.setLatLng([lat, lng]);
        }
        map.setView([lat, lng], 16);
      }
    }
  });
}

// Baca & Simpan TURN dari/ke Firebase (config/turn)
function initTurnSettings() {
  const turnRef = db.ref("config/turn");
  turnRef.on("value", (snap) => {
    const val = snap.val() || {};
    activeTurnUser = val.username || "";
    activeTurnPass = val.credential || "";
    document.getElementById("turn-username").value = activeTurnUser;
    document.getElementById("turn-credential").value = activeTurnPass;
  });

  document.getElementById("btn-save-turn").onclick = () => {
    const username = document.getElementById("turn-username").value.trim();
    const credential = document.getElementById("turn-credential").value.trim();
    const statusEl = document.getElementById("turn-save-status");

    turnRef.set({ username, credential })
      .then(() => {
        statusEl.style.color = "#22c55e";
        statusEl.textContent = "Tersimpan & sinkron!";
        setTimeout(() => { statusEl.textContent = ""; }, 3000);
      })
      .catch((err) => {
        statusEl.style.color = "#ef4444";
        statusEl.textContent = "Gagal simpan: " + err.message;
      });
  };
}

// Kontrol WebRTC
async function startRemoteStream(mode) {
  if (!currentUid) return;
  await stopRemoteStream();

  const statusEl = document.getElementById("webrtc-status");
  statusEl.textContent = `Status Stream: Meminta akses (${mode})...`;

  const webrtcRef = db.ref(`users/${currentUid}/webrtc`);
  await webrtcRef.remove();

  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (activeTurnUser && activeTurnPass) {
    iceServers.push(
      { urls: "turn:a.relay.metered.ca:80", username: activeTurnUser, credential: activeTurnPass },
      { urls: "turn:a.relay.metered.ca:443?transport=tcp", username: activeTurnUser, credential: activeTurnPass }
    );
  }

  peerConnection = new RTCPeerConnection({ iceServers });
  peerConnection.addTransceiver("video", { direction: "recvonly" });
  peerConnection.addTransceiver("audio", { direction: "recvonly" });

  peerConnection.ontrack = (event) => {
    const videoEl = document.getElementById("remote-video");
    if (event.streams && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
    }
    statusEl.textContent = `Status Stream: Terhubung (${mode})`;
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      webrtcRef.child("webCandidates").push({
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      });
    }
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  await webrtcRef.child("offer").set({
    sdp: offer.sdp,
    mode: mode
  });

  webrtcRef.child("answer").on("value", async (snap) => {
    const ans = snap.val();
    if (ans && ans.sdp && peerConnection && !peerConnection.currentRemoteDescription) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: "answer",
        sdp: ans.sdp
      }));
    }
  });

  webrtcRef.child("androidCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (cand && cand.candidate && peerConnection) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
    }
  });
}

async function stopRemoteStream() {
  if (currentUid) {
    const webrtcRef = db.ref(`users/${currentUid}/webrtc`);
    webrtcRef.child("answer").off();
    webrtcRef.child("androidCandidates").off();
    await webrtcRef.remove();
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  const videoEl = document.getElementById("remote-video");
  if (videoEl) videoEl.srcObject = null;
  document.getElementById("webrtc-status").textContent = "Status Stream: Idle";
}
