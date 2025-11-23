// ==================== FIREBASE CONFIGURATION ====================
const firebaseConfig = {
  apiKey: "AIzaSyCs5QzaGM_77HQ3Uy2e1J8HCfX9m5Sz3Ws",
  authDomain: "crash-guard-e27aa.firebaseapp.com",
  projectId: "crash-guard-e27aa",
  storageBucket: "crash-guard-e27aa.firebasestorage.app",
  messagingSenderId: "529685467844",
  appId: "1:529685467844:web:d2bf80f7a95c0797596f91"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ==================== ESP32 BLUETOOTH STATE ====================
const esp32State = {
  device: null,
  server: null,
  service: null,
  characteristic: null,
  connected: false,
  reconnecting: false,
  lastHeartbeat: null,
  dataBuffer: '',
  keepAliveInterval: null,
  connectionAttempts: 0,
  maxConnectionAttempts: 3
};

const UART_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const UART_CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
const KEEP_ALIVE_INTERVAL = 2000;

// ==================== SEVERITY DETECTION CONSTANTS ====================
const SEVERITY_THRESHOLDS = {
  MINOR: { min: 35, max: 50, countdown: 45, label: 'MINOR', color: '#ffa500' },
  MODERATE: { min: 50, max: 70, countdown: 30, label: 'MODERATE', color: '#ff6b35' },
  SEVERE: { min: 70, max: Infinity, countdown: 15, label: 'SEVERE', color: '#ff3b3b' }
};

// ==================== APP STATE ====================
const state = {
  contacts: [],
  tracking: false,
  watchId: null,
  lastPos: null,
  crashDetected: false,
  crashTimer: null,
  user: null,
  btDevice: null,
  crashLogs: [],
  theme: 'dark',
  helmetWorn: false,
  weatherData: null,
  lastWeatherNotification: null,
  currentUserId: null,
  crashSeverity: null,
  crashMagnitude: 0,
  nearbyHospitals: [],
  insuranceDetails: null
};

// ==================== FIREBASE AUTH LISTENER ====================
auth.onAuthStateChanged(async (user) => {
  if (user) {
    state.currentUserId = user.uid;
    await loadUserData(user.uid);
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    updateSettingsProfile();
    showHomePage();
    
    setTimeout(() => {
      showWeatherNotification();
    }, 1000);
  } else {
    state.currentUserId = null;
    state.user = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
  }
});

// ==================== FIREBASE DATA MANAGEMENT ====================
async function loadUserData(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      state.user = {
        name: userData.name,
        phone: userData.phone
      };
      state.theme = userData.theme || 'dark';
      state.lastWeatherNotification = userData.lastWeatherNotification || null;
      
      // Load insurance details
      if (userData.insurance) {
        state.insuranceDetails = userData.insurance;
        displayInsuranceDetails();
      }
      
      renderUser();
      applyTheme();
    }

    const contactsSnapshot = await db.collection('users').doc(userId).collection('contacts').get();
    state.contacts = [];
    contactsSnapshot.forEach(doc => {
      state.contacts.push({ id: doc.id, ...doc.data() });
    });
    renderContacts();

    const crashLogsSnapshot = await db.collection('users').doc(userId).collection('crashLogs')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    state.crashLogs = [];
    crashLogsSnapshot.forEach(doc => {
      state.crashLogs.push({ id: doc.id, ...doc.data() });
    });
    renderCrashLogs();

  } catch (error) {
    console.error('Error loading user data:', error);
    showError('Failed to load user data: ' + error.message);
  }
}

async function saveUserProfile(updates) {
  if (!state.currentUserId) return;
  try {
    await db.collection('users').doc(state.currentUserId).set(updates, { merge: true });
  } catch (error) {
    console.error('Error saving profile:', error);
    throw error;
  }
}

async function addContactToFirebase(contact) {
  if (!state.currentUserId) return;
  try {
    const docRef = await db.collection('users').doc(state.currentUserId).collection('contacts').add(contact);
    return docRef.id;
  } catch (error) {
    console.error('Error adding contact:', error);
    throw error;
  }
}

async function removeContactFromFirebase(contactId) {
  if (!state.currentUserId) return;
  try {
    await db.collection('users').doc(state.currentUserId).collection('contacts').doc(contactId).delete();
  } catch (error) {
    console.error('Error removing contact:', error);
    throw error;
  }
}

async function addCrashLogToFirebase(logEntry) {
  if (!state.currentUserId) return;
  try {
    const docRef = await db.collection('users').doc(state.currentUserId).collection('crashLogs').add(logEntry);
    return docRef.id;
  } catch (error) {
    console.error('Error adding crash log:', error);
    throw error;
  }
}

async function clearCrashLogsFromFirebase() {
  if (!state.currentUserId) return;
  try {
    const batch = db.batch();
    const snapshot = await db.collection('users').doc(state.currentUserId).collection('crashLogs').get();
    snapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  } catch (error) {
    console.error('Error clearing crash logs:', error);
    throw error;
  }
}

// ==================== NEARBY HOSPITALS FEATURE ====================
async function findNearbyHospitals() {
  const statusEl = document.getElementById('hospitalSearchStatus');
  const listEl = document.getElementById('hospitalsList');
  
  if (!state.lastPos) {
    statusEl.textContent = '⚠️ Location not available. Please enable GPS first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }
  
  statusEl.textContent = '🔍 Searching for nearby hospitals...';
  statusEl.style.color = 'var(--accent)';
  
  const lat = state.lastPos.coords.latitude;
  const lon = state.lastPos.coords.longitude;
  
  try {
    // Using Overpass API to find hospitals
    const query = `[out:json];
    (
      node["amenity"="hospital"](around:5000,${lat},${lon});
      way["amenity"="hospital"](around:5000,${lat},${lon});
      node["amenity"="clinic"](around:5000,${lat},${lon});
      way["amenity"="clinic"](around:5000,${lat},${lon});
    );
    out body;`;
    
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });
    
    const data = await response.json();
    
    if (data.elements && data.elements.length > 0) {
      // Calculate distances and sort
      const hospitalsWithDistance = data.elements.map(hospital => {
        const hospLat = hospital.lat || hospital.center?.lat;
        const hospLon = hospital.lon || hospital.center?.lon;
        
        if (!hospLat || !hospLon) return null;
        
        const distance = calculateDistance(lat, lon, hospLat, hospLon);
        
        return {
          name: hospital.tags?.name || 'Hospital',
          address: hospital.tags?.['addr:full'] || hospital.tags?.['addr:street'] || 'Address not available',
          phone: hospital.tags?.phone || hospital.tags?.['contact:phone'] || 'N/A',
          lat: hospLat,
          lon: hospLon,
          distance: distance,
          type: hospital.tags?.amenity || 'hospital'
        };
      }).filter(h => h !== null);
      
      // Sort by distance
      hospitalsWithDistance.sort((a, b) => a.distance - b.distance);
      
      // Take top 10
      state.nearbyHospitals = hospitalsWithDistance.slice(0, 10);
      
      displayHospitals(state.nearbyHospitals, listEl);
      statusEl.textContent = `✅ Found ${state.nearbyHospitals.length} nearby hospitals`;
      statusEl.style.color = 'var(--success)';
      
    } else {
      statusEl.textContent = '⚠️ No hospitals found nearby. Try refreshing or moving to a different location.';
      statusEl.style.color = 'var(--warning)';
      listEl.innerHTML = '<div class="card"><p style="text-align:center;color:var(--muted);">No hospitals found in 5km radius</p></div>';
    }
    
  } catch (error) {
    console.error('Error finding hospitals:', error);
    statusEl.textContent = '❌ Error searching hospitals. Please try again.';
    statusEl.style.color = 'var(--danger)';
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function displayHospitals(hospitals, container) {
  container.innerHTML = '';
  
  if (hospitals.length === 0) {
    container.innerHTML = '<div class="card"><p style="text-align:center;color:var(--muted);">No hospitals found</p></div>';
    return;
  }
  
  hospitals.forEach((hospital, index) => {
    const card = document.createElement('div');
    card.className = 'hospital-card';
    card.innerHTML = `
      <div class="hospital-name">${index + 1}. ${hospital.name}</div>
      <div class="hospital-info">
        <div class="hospital-info-row">
          <span>📍</span>
          <span class="hospital-distance">${hospital.distance.toFixed(2)} km away</span>
        </div>
        <div class="hospital-info-row">
          <span>📞</span>
          ${hospital.phone !== 'N/A' ? 
            `<a href="tel:${hospital.phone}" class="hospital-phone">${hospital.phone}</a>` : 
            '<span style="color:var(--muted);">Phone not available</span>'}
        </div>
        <div class="hospital-info-row">
          <span>📋</span>
          <span style="color:var(--muted);">${hospital.address}</span>
        </div>
      </div>
      <div class="hospital-actions">
        <button onclick="openHospitalDirections(${hospital.lat}, ${hospital.lon})">🗺️ Directions</button>
        ${hospital.phone !== 'N/A' ? 
          `<button onclick="window.open('tel:${hospital.phone}')" class="primary">📞 Call</button>` : 
          ''}
      </div>
    `;
    container.appendChild(card);
  });
}

function openHospitalDirections(lat, lon) {
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  window.open(url, '_blank');
}

function refreshHospitals() {
  findNearbyHospitals();
}

// ==================== HEALTH INSURANCE FEATURE ====================
async function saveInsuranceDetails() {
  const policyNumber = document.getElementById('insurancePolicyNumber').value.trim();
  const provider = document.getElementById('insuranceProvider').value.trim();
  const policyHolder = document.getElementById('insurancePolicyHolder').value.trim();
  const expiry = document.getElementById('insuranceExpiry').value;
  const helpline = document.getElementById('insuranceHelpline').value.trim();
  const claimNumber = document.getElementById('insuranceClaimNumber').value.trim();
  
  if (!policyNumber || !provider || !policyHolder) {
    alert('⚠️ Please fill in all required fields (Policy Number, Provider, Policy Holder)');
    return;
  }
  
  const insuranceData = {
    policyNumber,
    provider,
    policyHolder,
    expiry,
    helpline,
    claimNumber,
    lastUpdated: new Date().toISOString()
  };
  
  try {
    await saveUserProfile({ insurance: insuranceData });
    state.insuranceDetails = insuranceData;
    displayInsuranceDetails();
    
    document.getElementById('insuranceStatusText').textContent = 'Active';
    document.getElementById('insuranceStatusText').style.color = 'var(--success)';
    
    alert('✅ Insurance details saved successfully!');
    
  } catch (error) {
    console.error('Error saving insurance:', error);
    alert('❌ Failed to save insurance details: ' + error.message);
  }
}

function displayInsuranceDetails() {
  const container = document.getElementById('savedInsuranceInfo');
  
  if (!state.insuranceDetails) {
    container.innerHTML = '<p style="color:var(--muted);text-align:center;">No insurance information saved yet. Please fill in your details above.</p>';
    document.getElementById('insuranceStatusText').textContent = 'Not Configured';
    document.getElementById('insuranceStatusText').style.color = 'var(--danger)';
    return;
  }
  
  const ins = state.insuranceDetails;
  
  // Populate form fields
  document.getElementById('insurancePolicyNumber').value = ins.policyNumber || '';
  document.getElementById('insuranceProvider').value = ins.provider || '';
  document.getElementById('insurancePolicyHolder').value = ins.policyHolder || '';
  document.getElementById('insuranceExpiry').value = ins.expiry || '';
  document.getElementById('insuranceHelpline').value = ins.helpline || '';
  document.getElementById('insuranceClaimNumber').value = ins.claimNumber || '';
  
  // Display saved information
  const expiryDate = ins.expiry ? new Date(ins.expiry) : null;
  const isExpired = expiryDate && expiryDate < new Date();
  
  container.innerHTML = `
    <div class="insurance-info-display">
      <div class="insurance-detail-row">
        <span class="insurance-label">Policy Number:</span>
        <span class="insurance-value">${ins.policyNumber}</span>
      </div>
      <div class="insurance-detail-row">
        <span class="insurance-label">Provider:</span>
        <span class="insurance-value">${ins.provider}</span>
      </div>
      <div class="insurance-detail-row">
        <span class="insurance-label">Policy Holder:</span>
        <span class="insurance-value">${ins.policyHolder}</span>
      </div>
      <div class="insurance-detail-row">
        <span class="insurance-label">Expiry Date:</span>
        <span class="insurance-value" style="color:${isExpired ? 'var(--danger)' : 'var(--success)'}">
          ${ins.expiry ? new Date(ins.expiry).toLocaleDateString() : 'Not set'}
          ${isExpired ? ' (EXPIRED)' : ''}
        </span>
      </div>
      ${ins.helpline ? `
      <div class="insurance-detail-row">
        <span class="insurance-label">Helpline:</span>
        <span class="insurance-value">
          <a href="tel:${ins.helpline}" style="color:var(--accent);text-decoration:none;">${ins.helpline}</a>
        </span>
      </div>
      ` : ''}
      ${ins.claimNumber ? `
      <div class="insurance-detail-row">
        <span class="insurance-label">Claim Number:</span>
        <span class="insurance-value">${ins.claimNumber}</span>
      </div>
      ` : ''}
      <div class="insurance-detail-row">
        <span class="insurance-label">Last Updated:</span>
        <span class="insurance-value">${new Date(ins.lastUpdated).toLocaleDateString()}</span>
      </div>
    </div>
  `;
  
  if (isExpired) {
    document.getElementById('insuranceStatusText').textContent = 'Expired';
    document.getElementById('insuranceStatusText').style.color = 'var(--danger)';
  } else {
    document.getElementById('insuranceStatusText').textContent = 'Active';
    document.getElementById('insuranceStatusText').style.color = 'var(--success)';
  }
}

function callInsuranceHelpline() {
  if (state.insuranceDetails && state.insuranceDetails.helpline) {
    window.open('tel:' + state.insuranceDetails.helpline);
  } else {
    alert('⚠️ No insurance helpline number saved. Please add your insurance details first.');
  }
}

// ==================== ESP32 BLUETOOTH CONNECTION ====================
async function connectHelmet() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth not supported in this browser. Try Chrome/Edge.\n\nUsing mock connection instead.');
    mockConnect();
    return;
  }

  try {
    addLog('🔍 Searching for ESP32 Crash Guard...');
    
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'CrashGuard' },
        { namePrefix: 'ESP32' }
      ],
      optionalServices: [UART_SERVICE_UUID]
    });

    esp32State.device = device;
    addLog('📡 Found device: ' + device.name);

    const server = await device.gatt.connect();
    addLog('🔗 Connecting to GATT server...');

    const service = await server.getPrimaryService(UART_SERVICE_UUID);
    addLog('✓ UART service connected');

    const characteristic = await service.getCharacteristic(UART_CHARACTERISTIC_UUID);
    esp32State.characteristic = characteristic;

    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', handleESP32Data);

    esp32State.connected = true;
    state.btDevice = device;
    updateConnectionUI(true);
    addLog('✅ ESP32 Connected Successfully!');

    setTimeout(() => {
      sendCommandToESP32({ command: 'getStatus' });
    }, 1000);

    device.addEventListener('gattserverdisconnected', handleESP32Disconnect);

  } catch (error) {
    console.error('ESP32 connection error:', error);
    addLog('❌ Connection failed: ' + error.message);
    alert('Bluetooth connection failed: ' + error.message + '\n\nUsing mock connection instead.');
    mockConnect();
  }
}

// ==================== HANDLE ESP32 DATA ====================
function handleESP32Data(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const data = decoder.decode(value);
  
  esp32State.dataBuffer += data;
  
  const lines = esp32State.dataBuffer.split('\n');
  esp32State.dataBuffer = lines.pop();
  
  lines.forEach(line => {
    if (line.trim()) {
      processESP32Message(line.trim());
    }
  });
}

// ==================== PROCESS ESP32 MESSAGE ====================
function processESP32Message(jsonString) {
  try {
    const message = JSON.parse(jsonString);
    
    switch (message.type) {
      case 'sensorData':
        updateSensorData(message);
        break;
        
      case 'crashAlert':
        handleESP32CrashAlert(message);
        break;
        
      case 'heartbeat':
        esp32State.lastHeartbeat = Date.now();
        break;
        
      case 'statusUpdate':
        updateStatusFromESP32(message);
        break;
        
      case 'ack':
        console.log('ESP32 ACK:', message.message);
        break;
        
      default:
        console.log('Unknown message type:', message.type);
    }
  } catch (error) {
    console.error('JSON parse error:', error, 'Data:', jsonString);
  }
}

// ==================== UPDATE SENSOR DATA FROM ESP32 ====================
function updateSensorData(data) {
  const accel = data.acceleration;
  if (accel) {
    const magnitude = accel.magnitude.toFixed(2);
    document.getElementById('speed').textContent = `Accel: ${magnitude} m/s²`;
    
    if (magnitude > 20 && !state.crashDetected) {
      document.getElementById('crashStatus').textContent = `MONITORING (${magnitude} m/s²)`;
    }
  }
  
  const location = data.location;
  if (location && location.valid) {
    const lat = location.latitude.toFixed(6);
    const lon = location.longitude.toFixed(6);
    document.getElementById('coords').textContent = `Lat: ${lat} · Lon: ${lon}`;
    
    const speed = location.speed.toFixed(1);
    const satellites = location.satellites;
    document.getElementById('speed').textContent = `Speed: ${speed} km/h · ${satellites} sats`;
    
    updateMap(location.latitude, location.longitude);
    
    state.lastPos = {
      coords: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: 10
      }
    };
    
    document.getElementById('locTime').textContent = new Date().toLocaleTimeString();
  }
  
  if (typeof data.helmetWorn !== 'undefined') {
    updateHelmetWearStatus(data.helmetWorn);
  }
}

// ==================== HANDLE ESP32 CRASH ALERT ====================
function handleESP32CrashAlert(data) {
  if (state.crashDetected) return;
  
  addLog(`🚨 ESP32 CRASH DETECTED - ${data.severity} (${data.magnitude.toFixed(2)} m/s²)`);
  
  state.crashDetected = true;
  state.crashSeverity = data.severity;
  state.crashMagnitude = data.magnitude;
  
  document.getElementById('crashStatus').textContent = 'CRASH DETECTED';
  document.getElementById('crashStatus').style.color = 'var(--danger)';
  updateSeverityBadge(data.severity);
  
  if (data.location) {
    state.lastPos = {
      coords: {
        latitude: data.location.latitude,
        longitude: data.location.longitude,
        accuracy: 10
      }
    };
  }
  
  // Find nearby hospitals when crash is detected
  findNearbyHospitalsOnCrash();
  
  showCrashModal();
}

// ==================== UPDATE STATUS FROM ESP32 ====================
function updateStatusFromESP32(data) {
  console.log('ESP32 Status:', data);
  
  if (data.helmetWorn !== undefined) {
    updateHelmetWearStatus(data.helmetWorn);
  }
  
  if (data.gpsValid !== undefined) {
    const gpsStatus = data.gpsValid ? 
      `GPS: ${data.satellites} satellites` : 
      'GPS: Searching...';
    addLog(gpsStatus);
  }
  
  if (data.uptime !== undefined) {
    console.log(`ESP32 Uptime: ${data.uptime} seconds`);
  }
}

// ==================== SEND COMMAND TO ESP32 ====================
async function sendCommandToESP32(commandObj) {
  if (!esp32State.connected || !esp32State.characteristic) {
    console.warn('ESP32 not connected');
    return;
  }
  
  try {
    const jsonString = JSON.stringify(commandObj) + '\n';
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonString);
    
    await esp32State.characteristic.writeValue(data);
    console.log('→ Sent to ESP32:', commandObj);
  } catch (error) {
    console.error('Error sending command to ESP32:', error);
  }
}

// ==================== HANDLE ESP32 DISCONNECT ====================
function handleESP32Disconnect() {
  console.log('ESP32 disconnected');
  esp32State.connected = false;
  updateConnectionUI(false);
  addLog('❌ ESP32 Disconnected');
  
  if (!esp32State.reconnecting) {
    esp32State.reconnecting = true;
    setTimeout(() => {
      addLog('🔄 Attempting to reconnect...');
      if (esp32State.device && esp32State.device.gatt) {
        esp32State.device.gatt.connect()
          .then(() => {
            addLog('✅ Reconnected!');
            esp32State.reconnecting = false;
            connectHelmet();
          })
          .catch(err => {
            addLog('❌ Reconnection failed');
            esp32State.reconnecting = false;
          });
      }
    }, 3000);
  }
}

// ==================== UPDATE CONNECTION UI ====================
function updateConnectionUI(connected) {
  const statusText = connected ? 'Connected to ESP32' : 'Bluetooth disconnected';
  const statusColor = connected ? 'var(--success)' : 'var(--danger)';
  
  document.getElementById('btStatus').textContent = statusText;
  document.getElementById('btStatus').style.color = statusColor;
  
  if (document.getElementById('btStatusFull')) {
    document.getElementById('btStatusFull').textContent = connected ? 'Connected' : 'Disconnected';
    document.getElementById('btStatusFull').style.color = statusColor;
  }
  
  if (document.getElementById('btNameFull')) {
    document.getElementById('btNameFull').textContent = connected ? 
      (esp32State.device?.name || 'ESP32') : '—';
  }
  
  document.getElementById('helmetName').textContent = connected ? 
    (esp32State.device?.name || 'ESP32 Crash Guard') : '—';
  
  state.btDevice = connected ? esp32State.device : null;
  updateConnectivityStatus();
}

// ==================== ESP32 UTILITY FUNCTIONS ====================
function testESP32Buzzer() {
  sendCommandToESP32({ 
    command: 'soundBuzzer', 
    duration: 1000 
  });
  addLog('🔔 Testing ESP32 buzzer...');
}

function disconnectESP32() {
  if (esp32State.device && esp32State.device.gatt.connected) {
    esp32State.device.gatt.disconnect();
    addLog('🔌 ESP32 disconnected by user');
  }
  esp32State.connected = false;
  updateConnectionUI(false);
}

// ==================== ESP32 HEARTBEAT MONITOR ====================
setInterval(() => {
  if (esp32State.connected) {
    const timeSinceHeartbeat = Date.now() - (esp32State.lastHeartbeat || 0);
    
    if (timeSinceHeartbeat > 5000) {
      console.warn('No heartbeat from ESP32 for 5 seconds');
      addLog('⚠️ ESP32 connection weak');
    }
  }
}, 5000);

// ==================== SEVERITY DETECTION FUNCTIONS ====================
function detectCrashSeverity(magnitude) {
  if (magnitude >= SEVERITY_THRESHOLDS.SEVERE.min) {
    return 'SEVERE';
  } else if (magnitude >= SEVERITY_THRESHOLDS.MODERATE.min) {
    return 'MODERATE';
  } else if (magnitude >= SEVERITY_THRESHOLDS.MINOR.min) {
    return 'MINOR';
  }
  return 'NONE';
}

function updateSeverityBadge(severity) {
  const badge = document.getElementById('severityBadge');
  if (!badge) return;
  
  badge.classList.remove('severity-none', 'severity-minor', 'severity-moderate', 'severity-severe');
  
  if (severity === 'NONE' || !severity) {
    badge.classList.add('severity-none');
    badge.textContent = 'No Crash';
  } else if (severity === 'MINOR') {
    badge.classList.add('severity-minor');
    badge.textContent = '⚠️ MINOR CRASH';
  } else if (severity === 'MODERATE') {
    badge.classList.add('severity-moderate');
    badge.textContent = '⚠️ MODERATE CRASH';
  } else if (severity === 'SEVERE') {
    badge.classList.add('severity-severe');
    badge.textContent = '🚨 SEVERE CRASH';
  }
}

function getSeverityConfig(severity) {
  return SEVERITY_THRESHOLDS[severity] || { countdown: 30, label: 'UNKNOWN', color: '#ffa500' };
}

// ==================== NAVIGATION ====================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  document.getElementById(pageId).classList.add('active');
  if (event && event.target) {
    event.target.classList.add('active');
  }
}

// ==================== BUTTON CLICK SOUND ====================
function playClickSound() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.1);
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.1);
  } catch(e) {
    // Silently fail
  }
}

document.addEventListener('click', function(e) {
  if(e.target.tagName === 'BUTTON' || e.target.classList.contains('nav-item') || e.target.classList.contains('toggle-switch')) {
    playClickSound();
  }
});

// ==================== THEME SWITCHING ====================
async function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  
  if (state.currentUserId) {
    try {
      await saveUserProfile({ theme: state.theme });
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  }
}

function applyTheme() {
  const isLight = state.theme === 'light';
  const root = document.documentElement;
  const body = document.body;
  const loginScreen = document.getElementById('loginScreen');
  const loginRight = document.querySelector('.login-right');
  
  if(isLight) {
    root.classList.add('light');
    body.classList.add('light');
    if(loginScreen) loginScreen.classList.add('light');
    if(loginRight) loginRight.classList.add('light');
    
    document.querySelectorAll('.card').forEach(card => card.classList.add('light'));
    document.querySelectorAll('button').forEach(btn => {
      if(!btn.classList.contains('primary') && !btn.classList.contains('danger')) {
        btn.classList.add('light');
      }
    });
    document.querySelectorAll('.full-page').forEach(page => page.classList.add('light'));
    document.querySelectorAll('.app').forEach(app => app.classList.add('light'));
    document.querySelectorAll('.toggle-switch').forEach(toggle => toggle.classList.add('light'));
    document.querySelectorAll('.welcome-title').forEach(el => el.classList.add('light'));
    document.querySelectorAll('.welcome-description').forEach(el => el.classList.add('light'));
    document.querySelectorAll('h1').forEach(el => el.classList.add('light'));
    document.querySelectorAll('p.lead').forEach(el => el.classList.add('light'));
  } else {
    root.classList.remove('light');
    body.classList.remove('light');
    if(loginScreen) loginScreen.classList.remove('light');
    if(loginRight) loginRight.classList.remove('light');
    
    document.querySelectorAll('.card').forEach(card => card.classList.remove('light'));
    document.querySelectorAll('button').forEach(btn => btn.classList.remove('light'));
    document.querySelectorAll('.full-page').forEach(page => page.classList.remove('light'));
    document.querySelectorAll('.app').forEach(app => app.classList.remove('light'));
    document.querySelectorAll('.toggle-switch').forEach(toggle => toggle.classList.remove('light'));
    document.querySelectorAll('.welcome-title').forEach(el => el.classList.remove('light'));
    document.querySelectorAll('.welcome-description').forEach(el => el.classList.remove('light'));
    document.querySelectorAll('h1').forEach(el => el.classList.remove('light'));
    document.querySelectorAll('p.lead').forEach(el => el.classList.remove('light'));
  }
  
  const themeToggle = document.getElementById('themeToggle');
  if(themeToggle) {
    if(isLight) {
      themeToggle.classList.add('active');
    } else {
      themeToggle.classList.remove('active');
    }
  }
}

// ==================== ERROR MESSAGE DISPLAY ====================
function showError(message) {
  const errorDiv = document.getElementById('errorMessage');
  errorDiv.textContent = message;
  errorDiv.classList.add('show');
  
  setTimeout(() => {
    errorDiv.classList.remove('show');
  }, 5000);
}

// ==================== PHONE NUMBER VALIDATION ====================
function validateIndianPhone(phone) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  const indianPhoneRegex = /^(\+91|91)?[6-9]\d{9}$/;
  return indianPhoneRegex.test(cleanPhone);
}

function formatPhoneNumber(phone) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  if(cleanPhone.startsWith('+91')) {
    return cleanPhone;
  } else if(cleanPhone.startsWith('91')) {
    return '+' + cleanPhone;
  } else {
    return '+91' + cleanPhone;
  }
}

// ==================== LOGIN/SIGNUP FORM SWITCHING ====================
function showSignup() {
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'block';
  document.getElementById('errorMessage').classList.remove('show');
}

function showLogin() {
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('errorMessage').classList.remove('show');
}

// ==================== SIGNUP FUNCTION ====================
async function signupUser() {
  const name = document.getElementById('signupName').value.trim();
  const phone = document.getElementById('signupPhone').value.trim();
  const password = document.getElementById('signupPassword').value;
  const confirmPassword = document.getElementById('signupConfirmPassword').value;
  
  if(!name) {
    showError('⚠️ Please enter your name');
    return;
  }
  
  if(!phone) {
    showError('⚠️ Please enter your phone number');
    return;
  }
  
  if(!validateIndianPhone(phone)) {
    showError('⚠️ Invalid Indian phone number! Please enter a valid number starting with 6-9');
    return;
  }
  
  if(!password) {
    showError('⚠️ Please enter a password');
    return;
  }
  
  if(password.length < 6) {
    showError('⚠️ Password must be at least 6 characters long');
    return;
  }
  
  if(password !== confirmPassword) {
    showError('⚠️ Passwords do not match!');
    return;
  }
  
  const formattedPhone = formatPhoneNumber(phone);
  
  try {
    const email = `${formattedPhone.replace('+', '')}@crashguard.app`;
    
    const userCredential = await auth.createUserWithEmailAndPassword(email, password);
    const user = userCredential.user;
    
    await db.collection('users').doc(user.uid).set({
      name: name,
      phone: formattedPhone,
      email: email,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      theme: 'dark'
    });
    
    document.getElementById('signupName').value = '';
    document.getElementById('signupPhone').value = '';
    document.getElementById('signupPassword').value = '';
    document.getElementById('signupConfirmPassword').value = '';
    
  } catch (error) {
    console.error('Signup error:', error);
    if (error.code === 'auth/email-already-in-use') {
      showError('⚠️ Account with this phone number already exists! Please login.');
    } else {
      showError('⚠️ Signup failed: ' + error.message);
    }
  }
}

// ==================== LOGIN FUNCTION ====================
async function loginUser() {
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  
  if(!phone) {
    showError('⚠️ Please enter your phone number');
    return;
  }
  
  if(!validateIndianPhone(phone)) {
    showError('⚠️ Invalid Indian phone number!');
    return;
  }
  
  if(!password) {
    showError('⚠️ Please enter your password');
    return;
  }
  
  const formattedPhone = formatPhoneNumber(phone);
  
  try {
    const email = `${formattedPhone.replace('+', '')}@crashguard.app`;
    
    await auth.signInWithEmailAndPassword(email, password);
    
    document.getElementById('loginPhone').value = '';
    document.getElementById('loginPassword').value = '';
    
  } catch (error) {
    console.error('Login error:', error);
    if (error.code === 'auth/user-not-found') {
      showError('⚠️ Account not found! Please sign up first.');
    } else if (error.code === 'auth/wrong-password') {
      showError('❌ WRONG PASSWORD ENTERED! Please try again.');
    } else {
      showError('⚠️ Login failed: ' + error.message);
    }
  }
}

function showHomePage() {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  document.getElementById('home').classList.add('active');
  const firstNavItem = document.querySelector('.nav-item');
  if (firstNavItem) firstNavItem.classList.add('active');
}

async function logout() {
  if(confirm('Are you sure you want to logout?')) {
    try {
      await auth.signOut();
      document.getElementById('loginPhone').value = '';
      document.getElementById('loginPassword').value = '';
      showLogin();
      showHomePage();
    } catch (error) {
      console.error('Logout error:', error);
      showError('Logout failed: ' + error.message);
    }
  }
}

function renderUser() {
  const userText = state.user ? state.user.name + ' (' + state.user.phone + ')' : 'Not signed in';
  document.getElementById('loginUser').textContent = userText;
  if(document.getElementById('currentUser')) {
    document.getElementById('currentUser').textContent = userText;
  }
}

// ==================== SETTINGS FUNCTIONS ====================
async function updateProfile() {
  const name = document.getElementById('profileName').value.trim();
  if(!name) {
    alert('Please enter your name.');
    return;
  }
  
  try {
    await saveUserProfile({ name: name });
    state.user.name = name;
    renderUser();
    alert('Profile updated successfully!');
  } catch (error) {
    console.error('Error updating profile:', error);
    alert('Failed to update profile: ' + error.message);
  }
}

function updateSettingsProfile() {
  if(state.user) {
    document.getElementById('profileName').value = state.user.name;
    document.getElementById('profilePhone').value = state.user.phone;
  }
}

function savePrivacySettings() {
  alert('Privacy settings saved successfully!');
}

// ==================== WEATHER NOTIFICATION SYSTEM ====================
async function showWeatherNotification() {
  const today = new Date().toDateString();
  if(state.lastWeatherNotification === today) {
    return;
  }
  
  if(!state.lastPos) {
    navigator.geolocation.getCurrentPosition(async pos => {
      updatePosition(pos);
      await displayWeatherToast();
    }, err => {
      console.warn('Location needed for weather:', err);
    });
  } else {
    await displayWeatherToast();
  }
}

async function displayWeatherToast() {
  if(!state.lastPos) return;
  
  const lat = state.lastPos.coords.latitude;
  const lon = state.lastPos.coords.longitude;
  
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto`;
    const response = await fetch(url);
    const data = await response.json();
    
    if(data && data.current_weather) {
      state.weatherData = data;
      const weather = data.current_weather;
      const daily = data.daily;
      
      const weatherDesc = getWeatherDescription(weather.weathercode);
      const weatherIcon = getWeatherIcon(weather.weathercode);
      
      const toast = document.getElementById('weatherToast');
      const details = document.getElementById('toastWeatherDetails');
      
      document.querySelector('.weather-toast-icon').textContent = weatherIcon;
      details.innerHTML = `
        <strong>${weatherDesc}</strong><br>
        Temperature: ${weather.temperature}°C<br>
        Wind: ${weather.windspeed} km/h<br>
        High: ${daily.temperature_2m_max[0]}°C | Low: ${daily.temperature_2m_min[0]}°C
      `;
      
      toast.style.display = 'block';
      setTimeout(() => {
        toast.classList.remove('hide');
      }, 100);
      
      setTimeout(() => {
        closeWeatherToast();
      }, 10000);
      
      state.lastWeatherNotification = today;
      
      if (state.currentUserId) {
        try {
          await saveUserProfile({ lastWeatherNotification: today });
        } catch (error) {
          console.error('Error saving weather notification status:', error);
        }
      }
    }
  } catch(e) {
    console.warn('Weather notification error:', e);
  }
}

function closeWeatherToast() {
  const toast = document.getElementById('weatherToast');
  toast.classList.add('hide');
  setTimeout(() => {
    toast.style.display = 'none';
  }, 500);
}

function getWeatherDescription(code) {
  const weatherCodes = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
    55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
  };
  return weatherCodes[code] || 'Unknown';
}

function getWeatherIcon(code) {
  if(code === 0 || code === 1) return '☀️';
  if(code === 2 || code === 3) return '⛅';
  if(code === 45 || code === 48) return '🌫️';
  if(code >= 51 && code <= 55) return '🌦️';
  if(code >= 61 && code <= 65) return '🌧️';
  if(code >= 71 && code <= 77) return '🌨️';
  if(code >= 80 && code <= 82) return '🌧️';
  if(code >= 85 && code <= 86) return '🌨️';
  if(code >= 95) return '⛈️';
  return '🌤️';
}

// ==================== HELMET WEAR DETECTION ====================
function updateHelmetWearStatus(isWorn) {
  state.helmetWorn = isWorn;
  
  const statusBadge = document.getElementById('helmetWearStatus');
  const statusBadgeFull = document.getElementById('helmetWearStatusFull');
  
  if(statusBadge) {
    statusBadge.textContent = isWorn ? 'Worn' : 'Not Worn';
    if(isWorn) {
      statusBadge.classList.add('worn');
    } else {
      statusBadge.classList.remove('worn');
    }
  }
  
  if(statusBadgeFull) {
    statusBadgeFull.textContent = isWorn ? 'Worn' : 'Not Worn';
    if(isWorn) {
      statusBadgeFull.classList.add('worn');
    } else {
      statusBadgeFull.classList.remove('worn');
    }
  }
  
  addLog(`Helmet status: ${isWorn ? 'Worn' : 'Not Worn'}`);
}

function simulateHelmetWear() {
  const isWorn = Math.random() > 0.5;
  updateHelmetWearStatus(isWorn);
}

// ==================== CONTACTS ====================
function renderContacts() {
  const c = document.getElementById('contacts');
  c.innerHTML = '';
  state.contacts.forEach((ct, idx) => {
    const el = document.createElement('div');
    el.className = 'contact';
    el.innerHTML = `<div><strong>${ct.name}</strong><div class="small">${ct.phone}</div></div><div style="display:flex;gap:8px"><button style="padding:6px 10px;font-size:12px;min-width:70px" onclick="callContact(${idx})">Call</button><button style="padding:6px 10px;font-size:12px;min-width:70px" onclick="shareContact(${idx})">Share</button><button style="padding:6px 10px;font-size:12px;min-width:70px" onclick="removeContact(${idx})">Remove</button></div>`;
    c.appendChild(el);
  });
}

function openAddContact() {
  showModal(`<h3>Add contact</h3><div style='margin-top:8px'><label class='small'>Name</label><input id='newName' style='width:100%;padding:8px;border-radius:8px;background:var(--glass);border:1px solid rgba(255,255,255,0.03)'></div><div style='margin-top:8px'><label class='small'>Phone</label><input id='newPhone' style='width:100%;padding:8px;border-radius:8px;background:var(--glass);border:1px solid rgba(255,255,255,0.03)'></div><div style='display:flex;gap:8px;justify-content:flex-end;margin-top:12px'><button onclick="closeModal()">Cancel</button><button class='primary' onclick="addContactFromModal()">Add</button></div>`);
}

async function addContactFromModal() {
  const n = document.getElementById('newName').value.trim();
  const p = document.getElementById('newPhone').value.trim();
  if(!n || !p) {
    alert('Enter both name & phone');
    return;
  }
  
  try {
    const contact = { name: n, phone: p };
    const contactId = await addContactToFirebase(contact);
    state.contacts.unshift({ id: contactId, ...contact });
    renderContacts();
    closeModal();
  } catch (error) {
    console.error('Error adding contact:', error);
    alert('Failed to add contact: ' + error.message);
  }
} 

async function removeContact(i) {
  if(confirm('Remove contact?')) {
    try {
      const contact = state.contacts[i];
      if (contact.id) {
        await removeContactFromFirebase(contact.id);
      }
      state.contacts.splice(i, 1);
      renderContacts();
    } catch (error) {
      console.error('Error removing contact:', error);
      alert('Failed to remove contact: ' + error.message);
    }
  }
}

// ==================== LOCATION & TRACKING ====================
function requestLocation() {
  navigator.geolocation.getCurrentPosition(pos => {
    updatePosition(pos);
    alert('Location captured\nLat: ' + pos.coords.latitude.toFixed(5) + '\nLon: ' + pos.coords.longitude.toFixed(5) + '\nAccuracy: ' + pos.coords.accuracy + 'm');
    updateConnectivityStatus();
  }, err => {
    alert('Location error: ' + err.message + '\n\nMake sure:\n• Location services are enabled\n• Browser has location permission\n• You are outdoors or near a window');
    updateConnectivityStatus();
  }, {enableHighAccuracy: true, maximumAge: 0, timeout: 10000});
}

function updatePosition(pos) {
  const {latitude, longitude, accuracy} = pos.coords;
  state.lastPos = pos;
  document.getElementById('coords').textContent = `Lat: ${latitude.toFixed(6)} · Lon: ${longitude.toFixed(6)}`;
  document.getElementById('locTime').textContent = new Date().toLocaleTimeString();
  document.getElementById('speed').textContent = `Accuracy: ${accuracy.toFixed(0)}m`;
  
  if(accuracy > 100) {
    console.warn('Low GPS accuracy: ' + accuracy + 'm - Go outdoors for better signal');
  }
  
  fetchWeather(latitude, longitude);
  updateMap(latitude, longitude);
  updateConnectivityStatus();
}

function updateConnectivityStatus() {
  const locationStatusEl = document.getElementById('locationStatus');
  const locationAccuracyEl = document.getElementById('locationAccuracy');
  
  if(locationStatusEl) {
    if(state.lastPos) {
      locationStatusEl.textContent = 'Connected';
      locationStatusEl.style.color = 'var(--success)';
    } else {
      locationStatusEl.textContent = 'Disconnected';
      locationStatusEl.style.color = 'var(--danger)';
    }
  }
  
  if(locationAccuracyEl && state.lastPos) {
    locationAccuracyEl.textContent = `${state.lastPos.coords.accuracy.toFixed(0)}m`;
  }
  
  const btStatusFullEl = document.getElementById('btStatusFull');
  const btNameFullEl = document.getElementById('btNameFull');
  
  if(btStatusFullEl) {
    if(esp32State.connected || state.btDevice) {
      btStatusFullEl.textContent = 'Connected';
      btStatusFullEl.style.color = 'var(--success)';
    } else {
      btStatusFullEl.textContent = 'Disconnected';
      btStatusFullEl.style.color = 'var(--danger)';
    }
  }
  
  if(btNameFullEl) {
    btNameFullEl.textContent = (esp32State.device?.name || state.btDevice?.name) || '—';
  }
}

function toggleTracking() {
  if(state.tracking) {
    navigator.geolocation.clearWatch(state.watchId);
    state.tracking = false;
    state.watchId = null;
    const btn = document.getElementById('trackBtn');
    if(btn) btn.textContent = 'Start Tracker';
    addLog('Tracker stopped');
    alert('GPS Tracker stopped');
  } else {
    if(!navigator.geolocation) {
      alert('Geolocation not supported');
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      pos => {
        updatePosition(pos);
      },
      err => {
        console.warn(err);
        alert('GPS Error: ' + err.message + '\nTry:\n1. Enable location services\n2. Allow location permission\n3. Go outdoors for better signal');
      },
      {enableHighAccuracy: true, maximumAge: 0, timeout: 10000}
    );
    state.tracking = true;
    const btn = document.getElementById('trackBtn');
    if(btn) btn.textContent = 'Stop Tracker';
    addLog('Tracker started');
    alert('GPS Tracker started - monitoring your location');
  }
}

function updateMap(lat, lon) {
  const map = document.getElementById('map');
  map.innerHTML = `<iframe width='100%' height='100%' frameborder='0' src='https://www.google.com/maps?q=${lat},${lon}&z=16&output=embed' allowfullscreen></iframe>`;
}

function centerMap() {
  if(state.lastPos) {
    updateMap(state.lastPos.coords.latitude, state.lastPos.coords.longitude);
  } else {
    alert('No position yet');
  }
}

async function fetchWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const r = await fetch(url);
    const j = await r.json();
    if(j && j.current_weather) {
      const w = j.current_weather;
      document.getElementById('weatherSummary').textContent = `${w.temperature}°C, wind ${w.windspeed} m/s`;
      document.getElementById('temp').textContent = `${w.temperature}°C`;
      document.getElementById('weatherDetails').textContent = `Windspeed: ${w.windspeed} m/s · Weather code: ${w.weathercode}`;
    }
  } catch(e) {
    console.warn('Weather error', e);
  }
}

async function shareLocationNow(forceAmbulance = false) {
  if(!state.lastPos) {
    alert('No known location. Try "Get Location" first.');
    return;
  }
  
  const lat = state.lastPos.coords.latitude;
  const lon = state.lastPos.coords.longitude;
  const maps = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  
  const severityConfig = getSeverityConfig(state.crashSeverity);
  const severityInfo = state.crashSeverity ? ` [${severityConfig.label} CRASH - ${state.crashMagnitude.toFixed(1)} m/s²]` : '';
  
  // Add nearby hospitals info
  let hospitalsInfo = '';
  if (state.nearbyHospitals && state.nearbyHospitals.length > 0) {
    hospitalsInfo = '\n\nNearest Hospitals:\n';
    state.nearbyHospitals.slice(0, 3).forEach((h, idx) => {
      hospitalsInfo += `${idx + 1}. ${h.name} - ${h.distance.toFixed(2)}km`;
      if (h.phone !== 'N/A') hospitalsInfo += ` (${h.phone})`;
      hospitalsInfo += '\n';
    });
  }
  
  const subject = encodeURIComponent(`EMERGENCY: Need help${severityInfo}`);
  const body = encodeURIComponent(`I may have crashed.${severityInfo}\nMy location: ${maps}\nTime: ${new Date().toLocaleString()}\nUser: ${state.user ? state.user.name + ' (' + state.user.phone + ')' : 'Unknown'}${hospitalsInfo}`);

  if(navigator.share) {
    try {
      await navigator.share({title: 'EMERGENCY', text: `I may have crashed.${severityInfo} Location: ${maps}${hospitalsInfo}`});
      addLog('Shared via native share');
      return;
    } catch(e) {
      console.warn('Share cancelled', e);
    }
  }

  const recipients = state.contacts.map(c => c.phone + '@sms.gateway').join(',');
  window.open(`mailto:?subject=${subject}&body=${body}`);
  if(forceAmbulance) {
    setTimeout(() => {
      if(confirm('Call ambulance (108)?')) window.open('tel:108');
    }, 3000);
  }
}

async function sendAmbulance() {
  if(confirm('Call ambulance number 108?')) window.open('tel:108');
}

// ==================== MOCK BLUETOOTH CONNECTION ====================
function mockConnect() {
  state.btDevice = {name: 'Mock-Helmet-001'};
  document.getElementById('btStatus').textContent = 'Connected (mock)';
  document.getElementById('btStatus').style.color = 'var(--success)';
  if(document.getElementById('btName')) document.getElementById('btName').textContent = 'Mock-Helmet-001';
  if(document.getElementById('btNameFull')) document.getElementById('btNameFull').textContent = 'Mock-Helmet-001';
  document.getElementById('helmetName').textContent = 'Mock-Helmet-001';
  addLog('Mock helmet connected');
  updateConnectivityStatus();
  
  setTimeout(() => {
    simulateHelmetWear();
  }, 2000);
}

function openNavigator() {
  if(state.lastPos) {
    const lat = state.lastPos.coords.latitude;
    const lon = state.lastPos.coords.longitude;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    window.open(url, '_blank');
  } else {
    alert('No current location known. Get Location or enable Tracker first.');
  }
}

// ==================== INITIALIZATION ====================
navigator.geolocation.getCurrentPosition(p => {
  updatePosition(p);
}, () => {});

setTimeout(updateConnectivityStatus, 1000);

// Load insurance details on page load
setTimeout(() => {
  if (state.insuranceDetails) {
    displayInsuranceDetails();
  }
}, 2000);

// ==================== ESP32 INTEGRATION STATUS ====================
console.log('✅ ESP32 Integration Module Loaded');
console.log('📡 Ready to connect to ESP32 Crash Guard hardware');
console.log('🔧 Integrated Features:');
console.log('   • ESP32 Bluetooth connectivity with UART protocol');
console.log('   • Real-time sensor data processing');
console.log('   • Hardware crash detection with severity levels');
console.log('   • Helmet wear status monitoring');
console.log('   • GPS location tracking from ESP32');
console.log('   • Automatic reconnection on disconnect');
console.log('   • Firebase sync for crash logs and contacts');
console.log('   • Mock connection fallback for testing');
console.log('   • Nearby hospitals finder with distance calculation');
console.log('   • Health insurance management system');
console.log('');
console.log('🎯 To connect ESP32:');
console.log('   1. Power on your ESP32 Crash Guard device');
console.log('   2. Click "Connect Helmet" button in the app');
console.log('   3. Select your ESP32 device from the Bluetooth menu');
console.log('   4. Wait for successful connection confirmation');
console.log('');
console.log('⚡ ESP32 Commands Available:');
console.log('   • getStatus - Request device status');
console.log('   • resetCrash - Reset crash detection state');
console.log('   • soundBuzzer - Test hardware buzzer');
console.log('');
console.log('📊 Data Received from ESP32:');
console.log('   • sensorData - Acceleration & GPS data');
console.log('   • crashAlert - Real-time crash detection');
console.log('   • statusUpdate - Device status updates');
console.log('   • heartbeat - Connection health monitoring');
console.log('');
console.log('🏥 Hospital Features:');
console.log('   • Real-time nearby hospital search using Overpass API');
console.log('   • Distance calculation from current location');
console.log('   • Phone numbers and navigation support');
console.log('   • Automatic hospital search on crash detection');
console.log('');
console.log('🛡️ Insurance Features:');
console.log('   • Store policy details securely in Firebase');
console.log('   • Track expiry dates with alerts');
console.log('   • Quick access to helpline numbers');
console.log('   • Emergency claim contact information');
    

function callContact(i) {
  const c = state.contacts[i];
  window.open('tel:' + c.phone);
}

function shareContact(i) {
  const c = state.contacts[i];
  const body = `Emergency contact: ${c.name} - ${c.phone}`;
  if(navigator.share) {
    navigator.share({title: 'Emergency Contact', text: body});
  } else {
    alert(body);
  }
}

// ==================== MODAL HELPERS ====================
function showModal(html) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class='modal-backdrop'><div class='modal'>${html}</div></div>`;
  root.style.display = 'block';
}

function closeModal() {
  const root = document.getElementById('modalRoot');
  const modal = document.querySelector('.modal');
  if(modal) {
    modal.classList.remove('crash-modal');
  }
  root.innerHTML = '';
  root.style.display = 'none';
}

// ==================== CRASH DETECTION ====================
let motionAvailable = false;

function initMotion() {
  if(typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().then(res => {
      if(res === 'granted') {
        attachMotion();
      } else {
        document.getElementById('motionAvail').textContent = 'permission denied';
      }
    }).catch(() => {
      document.getElementById('motionAvail').textContent = 'no';
    });
  } else if(window.DeviceMotionEvent) {
    attachMotion();
  } else {
    document.getElementById('motionAvail').textContent = 'not supported';
  }
}

function attachMotion() {
  window.addEventListener('devicemotion', handleMotion);
  motionAvailable = true;
  document.getElementById('motionAvail').textContent = 'available';
}

function handleMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration;
  if(!acc) return;
  const x = acc.x || 0, y = acc.y || 0, z = acc.z || 0;
  const mag = Math.sqrt(x * x + y * y + z * z);
  if(mag > 35) {
    triggerCrash({source: 'motion', mag});
  }
}

initMotion();

// ==================== FIND HOSPITALS ON CRASH ====================
async function findNearbyHospitalsOnCrash() {
  if (!state.lastPos) {
    console.warn('No location available for hospital search');
    return;
  }
  
  const lat = state.lastPos.coords.latitude;
  const lon = state.lastPos.coords.longitude;
  
  try {
    const query = `[out:json];
    (
      node["amenity"="hospital"](around:5000,${lat},${lon});
      way["amenity"="hospital"](around:5000,${lat},${lon});
      node["amenity"="clinic"](around:5000,${lat},${lon});
    );
    out body;`;
    
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });
    
    const data = await response.json();
    
    if (data.elements && data.elements.length > 0) {
      const hospitalsWithDistance = data.elements.map(hospital => {
        const hospLat = hospital.lat || hospital.center?.lat;
        const hospLon = hospital.lon || hospital.center?.lon;
        
        if (!hospLat || !hospLon) return null;
        
        const distance = calculateDistance(lat, lon, hospLat, hospLon);
        
        return {
          name: hospital.tags?.name || 'Hospital',
          phone: hospital.tags?.phone || hospital.tags?.['contact:phone'] || 'N/A',
          lat: hospLat,
          lon: hospLon,
          distance: distance
        };
      }).filter(h => h !== null);
      
      hospitalsWithDistance.sort((a, b) => a.distance - b.distance);
      state.nearbyHospitals = hospitalsWithDistance.slice(0, 5);
      
      addLog(`Found ${state.nearbyHospitals.length} nearby hospitals`);
    }
  } catch (error) {
    console.error('Error finding hospitals on crash:', error);
  }
}

// ==================== SIMULATE CRASH (ESP32 AWARE) ====================
function simulateCrash() {
  if (esp32State.connected) {
    addLog('⚠️ Simulation mode - ESP32 will detect real crashes');
    alert('ESP32 is connected!\n\nReal crash detection is active.\nPhysically shake the ESP32 to trigger a crash alert.\n\nOr use "Test Buzzer" to verify connection.');
  } else {
    const randomMagnitudes = [40, 55, 80];
    const randomMag = randomMagnitudes[Math.floor(Math.random() * randomMagnitudes.length)];
    triggerCrash({source: 'manual', mag: randomMag});
  }
}

function triggerCrash(info) {
  if(state.crashDetected) return;
  
  state.crashDetected = true;
  state.crashMagnitude = info.mag || 40;
  state.crashSeverity = detectCrashSeverity(state.crashMagnitude);
  
  document.getElementById('crashStatus').textContent = 'CRASH DETECTED';
  document.getElementById('crashStatus').style.color = 'var(--danger)';
  
  updateSeverityBadge(state.crashSeverity);
  
  const ts = new Date().toLocaleString();
  const severityConfig = getSeverityConfig(state.crashSeverity);
  const logEntry = `${severityConfig.label} Crash detected (${info.source}) - Magnitude: ${state.crashMagnitude.toFixed(2)} m/s² at ${ts}`;
  addLog(logEntry);
  
  // Find nearby hospitals when crash is detected
  findNearbyHospitalsOnCrash();
  
  showCrashModal();
}

async function addLog(txt) {
  const logEntry = {
    text: txt,
    timestamp: new Date().toISOString(),
    severity: state.crashSeverity || 'UNKNOWN',
    magnitude: state.crashMagnitude || 0
  };
  
  try {
    const logId = await addCrashLogToFirebase(logEntry);
    state.crashLogs.unshift({ id: logId, ...logEntry });
    renderCrashLogs();
  } catch (error) {
    console.error('Error adding log:', error);
    state.crashLogs.unshift(logEntry);
    renderCrashLogs();
  }
}

function renderCrashLogs() {
  const fullLog = document.getElementById('fullCrashLog');
  if(fullLog) {
    fullLog.innerHTML = '';
    if(state.crashLogs.length === 0) {
      fullLog.innerHTML = '<div class="crash-log-item"><div style="font-weight:bold;color:var(--accent);">No crashes detected</div><div class="small">System is monitoring for crashes. Logs will appear here.</div></div>';
    } else {
      state.crashLogs.forEach(log => {
        const el = document.createElement('div');
        el.className = 'crash-log-item';
        
        let borderColor = 'var(--accent)';
        if(log.severity === 'MINOR') borderColor = 'var(--severity-minor)';
        else if(log.severity === 'MODERATE') borderColor = 'var(--severity-moderate)';
        else if(log.severity === 'SEVERE') borderColor = 'var(--severity-severe)';
        
        el.style.borderLeftColor = borderColor;
        
        let severityHTML = '';
        if(log.severity && log.severity !== 'UNKNOWN') {
          severityHTML = `<span class="severity-badge severity-${log.severity.toLowerCase()}" style="margin-left:8px;">${log.severity}</span>`;
        }
        
        el.innerHTML = `<div style="font-weight:bold;color:${borderColor};">${log.text} ${severityHTML}</div><div class="small">${new Date(log.timestamp).toLocaleString()}</div>`;
        fullLog.appendChild(el);
      });
      
      const summaryEl = document.createElement('div');
      summaryEl.className = 'crash-log-item';
      summaryEl.style.borderColor = 'var(--accent)';
      
      const severityCounts = {
        MINOR: state.crashLogs.filter(log => log.severity === 'MINOR').length,
        MODERATE: state.crashLogs.filter(log => log.severity === 'MODERATE').length,
        SEVERE: state.crashLogs.filter(log => log.severity === 'SEVERE').length
      };
      
      summaryEl.innerHTML = `
        <div style="font-weight:bold;color:var(--accent);">Total Crashes: ${state.crashLogs.length}</div>
        <div class="small">
          <span class="severity-badge severity-minor" style="margin-right:5px;">Minor: ${severityCounts.MINOR}</span>
          <span class="severity-badge severity-moderate" style="margin-right:5px;">Moderate: ${severityCounts.MODERATE}</span>
          <span class="severity-badge severity-severe">Severe: ${severityCounts.SEVERE}</span>
        </div>
      `;
      fullLog.insertBefore(summaryEl, fullLog.firstChild);
    }
  }
}

async function clearCrashHistory() {
  if(state.crashLogs.length === 0) {
    alert('No crash history to clear.');
    return;
  }
  
  if(confirm(`Are you sure you want to clear all crash history? This will permanently delete ${state.crashLogs.length} crash log(s).`)) {
    try {
      await clearCrashLogsFromFirebase();
      state.crashLogs = [];
      renderCrashLogs();
      addLog('Crash history cleared by user');
      alert('Crash history cleared successfully.');
    } catch (error) {
      console.error('Error clearing crash history:', error);
      alert('Failed to clear crash history: ' + error.message);
    }
  }
}

// ==================== CRASH MODAL WITH SEVERITY ====================
let countdown = 30;
let countdownInterval = null;

function createCrashBeep() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(500, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(700, audioContext.currentTime + 0.2);
    oscillator.type = 'square';
    
    gainNode.gain.setValueAtTime(0.4, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.4);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.4);
    
    return audioContext;
  } catch(e) {
    console.warn('Audio not supported:', e);
    return null;
  }
}

function playCrashBeep() {
  try {
    createCrashBeep();
  } catch(e) {
    console.warn('Could not play crash beep:', e);
  }
}

function createClockTick() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.08);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.08);
    
    return audioContext;
  } catch(e) {
    console.warn('Audio not supported:', e);
    return null;
  }
}

function playClockTick() {
  try {
    createClockTick();
  } catch(e) {
    console.warn('Could not play clock tick:', e);
  }
}

function showCrashModal() {
  const severityConfig = getSeverityConfig(state.crashSeverity);
  countdown = severityConfig.countdown;
  
  let alertMessage = '';
  let priorityText = '';
  
  if(state.crashSeverity === 'MINOR') {
    alertMessage = 'We detected a minor impact. Are you okay?';
    priorityText = 'Standard priority alert will be sent if no response.';
  } else if(state.crashSeverity === 'MODERATE') {
    alertMessage = 'We detected a moderate crash. Are you safe?';
    priorityText = 'Priority alert will be sent to emergency contacts if no response.';
  } else if(state.crashSeverity === 'SEVERE') {
    alertMessage = 'SEVERE CRASH DETECTED! Immediate response required!';
    priorityText = 'URGENT: Emergency services will be contacted immediately if no response!';
  }
  
  const severityBadge = `<span class="severity-badge severity-${state.crashSeverity.toLowerCase()}">${severityConfig.label} - ${state.crashMagnitude.toFixed(1)} m/s²</span>`;
  
  showModal(`
    <h3 class='crash-title'>⚠️ CRASH DETECTED ⚠️</h3>
    <div style='text-align:center;margin-top:12px;'>${severityBadge}</div>
    <div class='small' style='margin-top:8px;color:white;text-align:center;'>${alertMessage}</div>
    <div style='margin-top:12px;display:flex;gap:8px;align-items:center'>
      <div style='font-weight:700;font-size:18px' id='countdown'>00:${countdown < 10 ? '0' + countdown : countdown}</div>
      <div style='flex:1'></div>
      <button onclick='imSafe()' class='primary'>I am safe</button>
      <button onclick='contactNow()' class='danger'>Contact now</button>
    </div>
    <div style='margin-top:12px;text-align:center;'>
      <strong style='color:${severityConfig.color};'>WARNING:</strong> ${priorityText}
    </div>
    <div style='margin-top:12px'>
      <strong>Emergency Contacts:</strong>
      <div id='modalContacts'></div>
    </div>
  `);
  
  const modal = document.querySelector('.modal');
  if(modal) {
    modal.classList.add('crash-modal');
  }
  
  renderModalContacts();
  playCrashBeep();
  
  countdownInterval = setInterval(() => {
    countdown--;
    updateCountdown();
    playClockTick();
    
    if(countdown <= 0) {
      clearInterval(countdownInterval);
      closeModal();
      autoShareAfterCrash();
    }
  }, 1000);
}

function updateCountdown() {
  const mm = String(Math.floor(countdown / 60)).padStart(2, '0');
  const ss = String(countdown % 60).padStart(2, '0');
  if(document.getElementById('countdown')) {
    document.getElementById('countdown').textContent = `${mm}:${ss}`;
  }
}

function renderModalContacts() {
  const el = document.getElementById('modalContacts');
  if(!el) return;
  el.innerHTML = '';
  state.contacts.forEach(c => {
    const d = document.createElement('div');
    d.className = 'contact';
    d.innerHTML = `<div><strong>${c.name}</strong><div class='small'>${c.phone}</div></div><div><button onclick="window.open('tel:${c.phone}')">Call</button></div>`;
    el.appendChild(d);
  });
}

// ==================== I'M SAFE (ESP32 AWARE) ====================
function imSafe() {
  state.crashDetected = false;
  state.crashSeverity = null;
  state.crashMagnitude = 0;
  
  document.getElementById('crashStatus').textContent = 'SAFE';
  document.getElementById('crashStatus').style.color = 'var(--accent)';
  updateSeverityBadge('NONE');
  
  if(countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  
  sendCommandToESP32({ command: 'resetCrash' });
  
  addLog('User marked SAFE - ESP32 notified');
  closeModal();
}

function contactNow() {
  if(countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  closeModal();
  shareLocationNow(true);
}

async function autoShareAfterCrash() {
  const severityConfig = getSeverityConfig(state.crashSeverity);
  addLog(`No response to ${severityConfig.label} crash: auto-sharing location to contacts & calling ambulance`);
  await shareLocationNow(true);
  
  setTimeout(() => {
    if(confirm(`EMERGENCY: ${severityConfig.label} crash detected with no response. Calling ambulance (108) now?`)) {
      window.open('tel:108');
      addLog(`Emergency call placed to ambulance (108) for ${severityConfig.label} crash`);
    } else {
      window.open('tel:108');
      addLog(`Ambulance number (108) opened for manual calling - ${severityConfig.label} crash`);
    }
  }, 1000);
  
  state.crashDetected = false;
  state.crashSeverity = null;
  state.crashMagnitude = 0;
  document.getElementById('crashStatus').textContent = 'SAFE';
  document.getElementById('crashStatus').style.color = 'var(--accent)';
  updateSeverityBadge('NONE');
}

// ==================== LOCATION & TRACKING ====================
function requestLocation() {
  navigator.geolocation.getCurrentPosition(pos => {
    updatePosition(pos);
    alert('Location captured\nLat: ' + pos.coords.latitude.toFixed(5) + '\nLon: ' + pos.coords.longitude.toFixed(5) + '\nAccuracy: ' + pos.coords.accuracy + 'm');
    updateConnectivityStatus();
  }, err => {
    alert('Location error: ' + err.message + '\n\nMake sure:\n• Location services are enabled\n• Browser has location permission\n• You are outdoors or near a window');
    updateConnectivityStatus();
  }, {enableHighAccuracy: true, maximumAge: 0, timeout: 10000});
}

function updatePosition(pos) {
  const {latitude, longitude, accuracy} = pos.coords;
  state.lastPos = pos;
  document.getElementById('coords').textContent = `Lat: ${latitude.toFixed(6)} · Lon: ${longitude.toFixed(6)}`;
  document.getElementById('locTime').textContent = new Date().toLocaleTimeString();
  document.getElementById('speed').textContent = `Accuracy: ${accuracy.toFixed(0)}m`;
  
  if(accuracy > 100) {
    console.warn('Low GPS accuracy: ' + accuracy + 'm - Go outdoors for better signal');
  }
  
  fetchWeather(latitude, longitude);
  updateMap(latitude, longitude);
  updateConnectivityStatus();
}

function updateConnectivityStatus() {
  const locationStatusEl = document.getElementById('locationStatus');
  const locationAccuracyEl = document.getElementById('locationAccuracy');
  
  if(locationStatusEl) {
    if(state.lastPos) {
      locationStatusEl.textContent = 'Connected';
      locationStatusEl.style.color = 'var(--success)';
    } else {
      locationStatusEl.textContent = 'Disconnected';
      locationStatusEl.style.color = 'var(--danger)';
    }
  }
  
  if(locationAccuracyEl && state.lastPos) {
    locationAccuracyEl.textContent = `${state.lastPos.coords.accuracy.toFixed(0)}m`;
  }
  
  const btStatusFullEl = document.getElementById('btStatusFull');
  const btNameFullEl = document.getElementById('btNameFull');
  
  if(btStatusFullEl) {
    if(esp32State.connected || state.btDevice) {
      btStatusFullEl.textContent = 'Connected';
      btStatusFullEl.style.color = 'var(--success)';
    } else {
      btStatusFullEl.textContent = 'Disconnected';
      btStatusFullEl.style.color = 'var(--danger)';
    }
  }
  
  if(btNameFullEl) {
    btNameFullEl.textContent = (esp32State.device?.name || state.btDevice?.name) || '—';
  }
}

function toggleTracking() {
  if(state.tracking) {
    navigator.geolocation.clearWatch(state.watchId);
    state.tracking = false;
    state.watchId = null;
    const btn = document.getElementById('trackBtn');
    if(btn) btn.textContent = 'Start Tracker';
    addLog('Tracker stopped');
    alert('GPS Tracker stopped');
  } else {
    if(!navigator.geolocation) {
      alert('Geolocation not supported');
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      pos => {
        updatePosition(pos);
      },
      err => {
        console.warn(err);
        alert('GPS Error: ' + err.message + '\nTry:\n1. Enable location services\n2. Allow location permission\n3. Go outdoors for better signal');
      },
      {enableHighAccuracy: true, maximumAge: 0, timeout: 10000}
    );
    state.tracking = true;
    const btn = document.getElementById('trackBtn');
    if(btn) btn.textContent = 'Stop Tracker';
    addLog('Tracker started');
    alert('GPS Tracker started - monitoring your location');
  }
}

function updateMap(lat, lon) {
  const map = document.getElementById('map');
  map.innerHTML = `<iframe width='100%' height='100%' frameborder='0' src='https://www.google.com/maps?q=${lat},${lon}&z=16&output=embed' allowfullscreen></iframe>`;
}

function centerMap() {
  if(state.lastPos) {
    updateMap(state.lastPos.coords.latitude, state.lastPos.coords.longitude);
  } else {
    alert('No position yet');
  }
}

async function fetchWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const r = await fetch(url);
    const j = await r.json();
    if(j && j.current_weather) {
      const w = j.current_weather;
      document.getElementById('weatherSummary').textContent = `${w.temperature}°C, wind ${w.windspeed} m/s`;
      document.getElementById('temp').textContent = `${w.temperature}°C`;
      document.getElementById('weatherDetails').textContent = `Windspeed: ${w.windspeed} m/s · Weather code: ${w.weathercode}`;
    }
  } catch(e) {
    console.warn('Weather error', e);
  }
}

async function shareLocationNow(forceAmbulance = false) {
  if(!state.lastPos) {
    alert('No known location. Try "Get Location" first.');
    return;
  }
  
  const lat = state.lastPos.coords.latitude;
  const lon = state.lastPos.coords.longitude;
  const maps = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  
  const severityConfig = getSeverityConfig(state.crashSeverity);
  const severityInfo = state.crashSeverity ? ` [${severityConfig.label} CRASH - ${state.crashMagnitude.toFixed(1)} m/s²]` : '';
  
  const subject = encodeURIComponent(`EMERGENCY: Need help${severityInfo}`);
  const body = encodeURIComponent(`I may have crashed.${severityInfo}\nMy location: ${maps}\nTime: ${new Date().toLocaleString()}\nUser: ${state.user ? state.user.name + ' (' + state.user.phone + ')' : 'Unknown'}`);

  if(navigator.share) {
    try {
      await navigator.share({title: 'EMERGENCY', text: `I may have crashed.${severityInfo} Location: ${maps}`});
      addLog('Shared via native share');
      return;
    } catch(e) {
      console.warn('Share cancelled', e);
    }
  }

  const recipients = state.contacts.map(c => c.phone + '@sms.gateway').join(',');
  window.open(`mailto:?subject=${subject}&body=${body}`);
  if(forceAmbulance) {
    setTimeout(() => {
      if(confirm('Call ambulance (108)?')) window.open('tel:108');
    }, 3000);
  }
}

async function sendAmbulance() {
  if(confirm('Call ambulance number 108?')) window.open('tel:108');
}

// ==================== MOCK BLUETOOTH CONNECTION ====================
function mockConnect() {
  state.btDevice = {name: 'Mock-Helmet-001'};
  document.getElementById('btStatus').textContent = 'Connected (mock)';
  document.getElementById('btStatus').style.color = 'var(--success)';
  if(document.getElementById('btName')) document.getElementById('btName').textContent = 'Mock-Helmet-001';
  if(document.getElementById('btNameFull')) document.getElementById('btNameFull').textContent = 'Mock-Helmet-001';
  document.getElementById('helmetName').textContent = 'Mock-Helmet-001';
  addLog('Mock helmet connected');
  updateConnectivityStatus();
  
  setTimeout(() => {
    simulateHelmetWear();
  }, 2000);
}

function openNavigator() {
  if(state.lastPos) {
    const lat = state.lastPos.coords.latitude;
    const lon = state.lastPos.coords.longitude;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    window.open(url, '_blank');
  } else {
    alert('No current location known. Get Location or enable Tracker first.');
  }
}

// ==================== INITIALIZATION ====================
navigator.geolocation.getCurrentPosition(p => {
  updatePosition(p);
}, () => {});

setTimeout(updateConnectivityStatus, 1000);

// ==================== ESP32 INTEGRATION STATUS ====================
console.log('✅ ESP32 Integration Module Loaded');
console.log('📡 Ready to connect to ESP32 Crash Guard hardware');
console.log('🔧 Integrated Features:');
console.log('   • ESP32 Bluetooth connectivity with UART protocol');
console.log('   • Real-time sensor data processing');
console.log('   • Hardware crash detection with severity levels');
console.log('   • Helmet wear status monitoring');
console.log('   • GPS location tracking from ESP32');
console.log('   • Automatic reconnection on disconnect');
console.log('   • Firebase sync for crash logs and contacts');
console.log('   • Mock connection fallback for testing');
console.log('');
console.log('🎯 To connect ESP32:');
console.log('   1. Power on your ESP32 Crash Guard device');
console.log('   2. Click "Connect Helmet" button in the app');
console.log('   3. Select your ESP32 device from the Bluetooth menu');
console.log('   4. Wait for successful connection confirmation');
console.log('');
console.log('⚡ ESP32 Commands Available:');
console.log('   • getStatus - Request device status');
console.log('   • resetCrash - Reset crash detection state');
console.log('   • soundBuzzer - Test hardware buzzer');
console.log('');
console.log('📊 Data Received from ESP32:');
console.log('   • sensorData - Acceleration & GPS data');
console.log('   • crashAlert - Real-time crash detection');
console.log('   • statusUpdate - Device status updates');
console.log('   • heartbeat - Connection health monitoring');