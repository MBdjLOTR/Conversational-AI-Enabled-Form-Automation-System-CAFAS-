/* ================= STATE ================= */
let isMuted = false;
let assistantActive = false;
let lastMemory = {};
let isProcessing = false;
let retryCount = 0;
const MAX_RETRIES = 3;
let currentUtterance = null;
let recognition = null;
let isRecognitionActive = false;
let isWaitingForResponse = false;

/* ================= FIELDS ================= */
const fields = [
  { id: "name", label: "name", type: "text" },
  { id: "email", label: "email", type: "text" },
  { id: "dob", label: "date of birth", type: "date" },
  { id: "gender", label: "gender", type: "radio" },
  { id: "interest", label: "interests", type: "checkbox" },
  { id: "rating", label: "satisfaction", type: "rating" }
];

/* ================= NORMALIZE SPEECH ================= */
function normalizeSpokenEmail(text) {
    let normalized = text.toLowerCase();
    
    // Email spoken patterns
    normalized = normalized.replace(/\s*at the rate\s*/gi, '@');
    normalized = normalized.replace(/\s*at\s*the\s*rate\s*/gi, '@');
    normalized = normalized.replace(/\s*at\s*rate\s*/gi, '@');
    normalized = normalized.replace(/\s*at\s*/gi, '@');
    normalized = normalized.replace(/\s*@\s*/gi, '@');
    
    // Dot replacements
    normalized = normalized.replace(/\s*dot\s*/gi, '.');
    normalized = normalized.replace(/\s*point\s*/gi, '.');
    normalized = normalized.replace(/\s*\.\s*/gi, '.');
    
    // Remove spaces
    normalized = normalized.replace(/\s+/g, '');
    
    // Fix common domains
    normalized = normalized.replace(/gmail\.com/gi, 'gmail.com');
    normalized = normalized.replace(/yahoo\.com/gi, 'yahoo.com');
    normalized = normalized.replace(/hotmail\.com/gi, 'hotmail.com');
    normalized = normalized.replace(/outlook\.com/gi, 'outlook.com');
    normalized = normalized.replace(/gmailcom/gi, 'gmail.com');
    
    return normalized;
}

/* ================= SPEECH ================= */
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

function initRecognition() {
  if (!SpeechRecognitionAPI) {
    console.error("Speech recognition not supported");
    alert("Your browser doesn't support speech recognition. Please use Chrome, Edge, or Safari.");
    return null;
  }
  
  if (recognition) {
    try {
      recognition.abort();
      recognition = null;
    } catch(e) {}
  }
  
  const recog = new SpeechRecognitionAPI();
  recog.interimResults = true;
  recog.continuous = false;
  recog.maxAlternatives = 1;
  
  const langSelect = document.getElementById("lang");
  if (langSelect) {
    recog.lang = langSelect.value;
  }
  
  console.log("Recognition initialized with lang:", recog.lang);
  return recog;
}

function startListening() {
  if (!assistantActive) {
    console.log("Assistant not active");
    return;
  }
  
  if (isProcessing) {
    console.log("Already processing");
    return;
  }
  
  if (isRecognitionActive) {
    console.log("Already listening");
    return;
  }
  
  if (!recognition) {
    console.log("Creating new recognition instance");
    recognition = initRecognition();
    if (!recognition) return;
    setupRecognitionHandlers(recognition);
  }
  
  try {
    console.log("Starting recognition...");
    recognition.start();
    isRecognitionActive = true;
    
    const micIndicator = document.getElementById("micIndicator");
    const waveform = document.getElementById("waveform");
    if (micIndicator) micIndicator.classList.add("active");
    if (waveform) waveform.classList.remove("hidden");
    
    const statusElement = document.getElementById("statusText");
    if (statusElement) statusElement.innerText = "🎤 Listening... Speak now";
    
  } catch (error) {
    console.error("Start recognition error:", error);
    isRecognitionActive = false;
    recognition = null;
    setTimeout(() => {
      if (assistantActive && !isRecognitionActive) {
        startListening();
      }
    }, 500);
  }
}

function setupRecognitionHandlers(recog) {
  recog.onstart = () => {
    console.log("Recognition started - MIC is ON");
    isRecognitionActive = true;
    isProcessing = true;
    
    const micIndicator = document.getElementById("micIndicator");
    const waveform = document.getElementById("waveform");
    const statusElement = document.getElementById("statusText");
    
    if (micIndicator) micIndicator.classList.add("active");
    if (waveform) waveform.classList.remove("hidden");
    if (statusElement) statusElement.innerText = "🎤 Listening...";
  };

  recog.onend = () => {
    console.log("Recognition ended");
    isRecognitionActive = false;
    
    const micIndicator = document.getElementById("micIndicator");
    const waveform = document.getElementById("waveform");
    
    if (micIndicator) micIndicator.classList.remove("active");
    if (waveform) waveform.classList.add("hidden");
    
    setTimeout(() => {
      isProcessing = false;
    }, 100);
  };

  recog.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    isRecognitionActive = false;
    isProcessing = false;
    
    const statusElement = document.getElementById("statusText");
    
    if (event.error === "no-speech") {
      if (statusElement) statusElement.innerText = "No speech detected. Please try again.";
      if (assistantActive && !isWaitingForResponse) {
        speak("I didn't hear anything. Please try again.", () => {
          setTimeout(() => startListening(), 500);
        });
      }
    } else if (event.error === "audio-capture") {
      if (statusElement) statusElement.innerText = "❌ Microphone error. Please check permissions.";
      speak("Please allow microphone access and try again.");
      assistantActive = false;
    } else if (event.error === "not-allowed") {
      if (statusElement) statusElement.innerText = "❌ Microphone access denied.";
      speak("Please allow microphone access to use voice features.");
      assistantActive = false;
    } else {
      if (statusElement) statusElement.innerText = `Error: ${event.error}. Please try again.`;
    }
  };

  recog.onresult = async (event) => {
    if (!assistantActive) return;
    
    let transcript = event.results[0][0].transcript;
    console.log("Original transcript:", transcript);
    
    transcript = normalizeSpokenEmail(transcript);
    console.log("Normalized transcript:", transcript);
    
    const heardElement = document.getElementById("heardText");
    if (heardElement) heardElement.innerText = transcript;
    
    const currentField = getNextField();
    const isEmailField = currentField?.id === "email";
    
    const statusElement = document.getElementById("statusText");
    if (statusElement) statusElement.innerText = "⏳ Processing...";

    try {
      const res = await fetch("/process-voice", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          text: transcript,
          session_id: Date.now().toString(),
          current_field: currentField?.id
        })
      });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      console.log("Response:", data);

      updateConfidence(data.confidence || 0);
      updateAccuracy(data.accuracy_score || 0);
      handleMemory(data.memory || {});

      if (data.intent === "SUBMIT") {
        speak("Submitting form.", saveData);
        return;
      }

      let filled = false;
      
      if (data.data && Object.keys(data.data).length > 0) {
        Object.keys(data.data).forEach(key => {
          const field = fields.find(f => f.id === key);
          if (field && data.data[key]) {
            if (fillField(field, data.data[key])) {
              filled = true;
              console.log(`Field ${key} filled with:`, data.data[key]);
            }
          }
        });
      }
      
      // If email field is active and we have a normalized transcript with @, try direct fill
      if (!filled && isEmailField && (transcript.includes('@') || transcript.includes('gmail.com') || transcript.includes('yahoo.com'))) {
        console.log("Direct email fill:", transcript);
        const emailField = fields.find(f => f.id === "email");
        if (emailField && fillField(emailField, transcript)) {
          filled = true;
          if (statusElement) statusElement.innerText = "✓ Email filled!";
        }
      }
      
      if (filled) {
        if (statusElement && statusElement.innerText !== "✓ Email filled!") {
          statusElement.innerText = "✓ Field filled!";
        }
        retryCount = 0;
      } else {
        if (statusElement) statusElement.innerText = "❌ Couldn't extract field. Please try again.";
      }

    } catch (error) {
      console.error("Error processing voice:", error);
      const statusElement = document.getElementById("statusText");
      if (statusElement) statusElement.innerText = "⚠️ Connection error. Retrying...";
      
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        setTimeout(() => {
          if (assistantActive) startListening();
        }, 1000);
      } else {
        speak("I'm having trouble understanding. Let's try again.", () => {
          retryCount = 0;
          if (assistantActive) promptNextField();
        });
        return;
      }
    }

    isProcessing = false;
    
    setTimeout(() => {
      if (assistantActive && !isProcessing) {
        promptNextField();
      }
    }, 800);
  };
}

/* ================= VOICES ================= */
let voices = [];

function loadVoices() {
  return new Promise((resolve) => {
    if (speechSynthesis.getVoices().length > 0) {
      voices = speechSynthesis.getVoices();
      resolve(voices);
    } else {
      speechSynthesis.onvoiceschanged = () => {
        voices = speechSynthesis.getVoices();
        resolve(voices);
      };
    }
  });
}

/* ================= SPEAK ================= */
function speak(text, callback) {
  if (isMuted) {
    if (callback) setTimeout(callback, 100);
    return;
  }
  
  if (currentUtterance) {
    speechSynthesis.cancel();
  }
  
  const lang = document.getElementById("lang").value || "en-US";
  const utterance = new SpeechSynthesisUtterance(text);
  
  utterance.lang = lang;
  utterance.rate = 0.85;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  
  let selectedVoice = voices.find(v => v.lang === lang && v.default);
  if (!selectedVoice) {
    const langFamily = lang.split('-')[0];
    selectedVoice = voices.find(v => v.lang.startsWith(langFamily));
  }
  if (!selectedVoice) {
    selectedVoice = voices.find(v => v.lang.startsWith('en'));
  }
  if (!selectedVoice && voices.length > 0) {
    selectedVoice = voices[0];
  }
  
  if (selectedVoice) utterance.voice = selectedVoice;
  
  const confirmationDiv = document.getElementById("confirmation");
  if (confirmationDiv) {
    confirmationDiv.innerText = text;
    setTimeout(() => {
      if (confirmationDiv.innerText === text) {
        confirmationDiv.innerText = "";
      }
    }, 3000);
  }
  
  if (callback) {
    utterance.onend = () => {
      currentUtterance = null;
      setTimeout(callback, 200);
    };
  }
  
  utterance.onerror = (e) => {
    console.error("Speech error:", e);
    currentUtterance = null;
    if (callback) setTimeout(callback, 200);
  };
  
  currentUtterance = utterance;
  
  setTimeout(() => {
    speechSynthesis.speak(utterance);
  }, 50);
}

/* ================= CONFIDENCE UI ================= */
function updateConfidence(conf) {
  const fill = document.getElementById("confidenceFill");
  const text = document.getElementById("confidenceText");
  const percent = Math.round(conf * 100);
  if (fill) fill.style.width = percent + "%";
  if (text) text.innerText = percent + "%";
  updateConfidenceChart(percent);
}

function updateAccuracy(score) {
  const el = document.getElementById("accuracyScore");
  if (el) el.innerText = score.toFixed(2);
}

let confidenceChart;

function initChart() {
  const ctx = document.getElementById("confidenceChart");
  if (!ctx) {
    console.warn("Chart canvas not found");
    return;
  }
  try {
    confidenceChart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Confidence', data: [], tension: 0.3, borderColor: '#4CAF50', backgroundColor: 'rgba(76, 175, 80, 0.1)', fill: true }] },
      options: { responsive: true, maintainAspectRatio: true, scales: { y: { min: 0, max: 100, title: { display: true, text: 'Confidence (%)' } }, x: { title: { display: true, text: 'Time' } } } }
    });
    console.log("Chart initialized");
  } catch(e) {
    console.error("Failed to initialize chart:", e);
  }
}

function updateConfidenceChart(value) {
  if (!confidenceChart) return;
  const time = new Date().toLocaleTimeString();
  confidenceChart.data.labels.push(time);
  confidenceChart.data.datasets[0].data.push(value);
  if (confidenceChart.data.labels.length > 10) {
    confidenceChart.data.labels.shift();
    confidenceChart.data.datasets[0].data.shift();
  }
  confidenceChart.update();
}

/* ================= MEMORY ================= */
function showMemoryCorrection(oldVal, newVal, field) {
  const box = document.getElementById("memoryCorrection");
  const text = document.getElementById("memoryText");
  if (!box || !text) return;
  text.innerText = `You said "${oldVal}" earlier. Change to "${newVal}"?`;
  box.classList.remove("hidden");
  document.getElementById("confirmMemory").onclick = () => {
    fillField(fields.find(f => f.id === field), newVal);
    box.classList.add("hidden");
  };
  document.getElementById("rejectMemory").onclick = () => {
    box.classList.add("hidden");
  };
}

function handleMemory(memory) {
  for (let key in memory) {
    if (lastMemory[key] && lastMemory[key] !== memory[key]) {
      showMemoryCorrection(lastMemory[key], memory[key], key);
    }
  }
  lastMemory = memory;
}

/* ================= FORM ================= */
function renderForm() {
  console.log("Rendering form...");
  const form = document.getElementById("userForm");
  if (!form) {
    console.error("Form element not found!");
    return;
  }
  
  form.innerHTML = "";
  
  fields.forEach(field => {
    const card = document.createElement("div");
    card.className = "field-card";
    card.id = "card_" + field.id;
    
    let html = `<label>${field.label.charAt(0).toUpperCase() + field.label.slice(1)}</label>`;
    
    if (field.type === "text" || field.type === "date") {
      html += `<input type="${field.type}" id="${field.id}" placeholder="Enter ${field.label}" autocomplete="off">`;
    }
    else if (field.type === "radio") {
      ["Male","Female","Other"].forEach(opt => {
        html += `<label><input type="radio" name="${field.id}" id="gender_${opt}" value="${opt}"> ${opt}</label>`;
      });
    }
    else if (field.type === "checkbox") {
      ["Music","Sports","Tech"].forEach(opt => {
        html += `<label><input type="checkbox" id="interest_${opt}" value="${opt}"> ${opt}</label>`;
      });
    }
    else if (field.type === "rating") {
      html += `<div id="stars_${field.id}" class="star-rating">`;
      for (let i = 1; i <= 5; i++) {
        html += `<span class="star" data-value="${i}">★</span>`;
      }
      html += `</div><input type="hidden" id="rating" name="rating">`;
    }
    
    html += `<div class="field-status" id="${field.id}_status"></div>`;
    card.innerHTML = html;
    form.appendChild(card);
  });
  
  // Add star rating functionality
  document.querySelectorAll('.star-rating').forEach(ratingContainer => {
    const stars = ratingContainer.querySelectorAll('.star');
    const ratingInput = document.getElementById('rating');
    stars.forEach(star => {
      star.addEventListener('click', function() {
        const value = parseInt(this.dataset.value);
        if (ratingInput) ratingInput.value = value;
        stars.forEach((s, i) => { s.classList.toggle('active', i < value); });
        const statusEl = document.getElementById("rating_status");
        if (statusEl && value) statusEl.innerText = "✔ Filled";
        updateProgress();
      });
    });
  });
  
  console.log("Form rendered successfully with", fields.length, "fields");
}

function getNextField() {
  for (const field of fields) {
    if (field.type === "radio") {
      const radios = document.getElementsByName(field.id);
      if (!radios || radios.length === 0) continue;
      if (!Array.from(radios).some(r => r.checked)) return field;
    }
    else if (field.type === "checkbox") {
      const checkboxes = document.querySelectorAll(`#card_${field.id} input:checked`);
      if (!checkboxes || checkboxes.length === 0) return field;
    }
    else if (field.type === "rating") {
      if (!document.getElementById("rating")?.value) return field;
    }
    else if (field.type === "text" || field.type === "date") {
      const el = document.getElementById(field.id);
      if (!el || !el.value) return field;
    }
  }
  return null;
}

function fillField(field, value) {
  if (!value || !field) return false;
  
  const card = document.getElementById("card_" + field.id);
  if (card) card.classList.add("field-filled");
  
  try {
    if (field.type === "radio") {
      const radioToClick = document.getElementById(`gender_${value}`);
      if (radioToClick) { 
        radioToClick.checked = true; 
        radioToClick.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    else if (field.type === "checkbox") {
      const values = Array.isArray(value) ? value : [value];
      values.forEach(v => {
        const checkbox = document.getElementById(`interest_${v}`);
        if (checkbox && !checkbox.checked) { 
          checkbox.checked = true; 
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
    else if (field.type === "rating") {
      const ratingInput = document.getElementById("rating");
      if (ratingInput) {
        ratingInput.value = value;
        document.querySelectorAll('.star').forEach((star, i) => { 
          star.classList.toggle('active', i < value); 
        });
      }
    }
    else {
      const inputElement = document.getElementById(field.id);
      if (inputElement) { 
        inputElement.value = value; 
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    
    const statusEl = document.getElementById(field.id + "_status");
    if (statusEl) statusEl.innerText = "✔ Filled";
    updateProgress();
    return true;
  } catch (error) {
    console.error(`Error filling field ${field.id}:`, error);
    return false;
  }
}

function updateProgress() {
  const filledCount = fields.filter(field => {
    if (field.type === "radio") {
      const radios = document.getElementsByName(field.id);
      return radios && Array.from(radios).some(r => r.checked);
    }
    if (field.type === "checkbox") {
      const checkboxes = document.querySelectorAll(`#card_${field.id} input:checked`);
      return checkboxes && checkboxes.length > 0;
    }
    if (field.type === "rating") return document.getElementById("rating")?.value;
    const el = document.getElementById(field.id);
    return el && el.value;
  }).length;
  
  const percentage = (filledCount / fields.length) * 100;
  const progressBar = document.getElementById("progressBar");
  if (progressBar) progressBar.style.width = percentage + "%";
}

function promptNextField() {
  if (!assistantActive || isProcessing) return;
  
  const field = getNextField();
  if (!field) {
    speak("All fields completed. Submitting now.", saveData);
    return;
  }
  
  const prompts = {
    "name": "Please tell me your full name",
    "email": "What is your email address?",
    "dob": "What is your date of birth?",
    "gender": "Please specify your gender",
    "interest": "What are your interests? You can say music, sports, or tech",
    "rating": "How would you rate your satisfaction? Please say a number from 1 to 5"
  };
  
  const prompt = prompts[field.id] || `Please provide your ${field.label}`;
  console.log("Prompting for:", field.id, prompt);
  
  speak(prompt, () => {
    console.log("Prompt finished, starting to listen...");
    setTimeout(() => {
      startListening();
    }, 300);
  });
}

function saveData() {
  fetch("/save", { method: "POST" })
    .then(response => response.json())
    .then(() => {
      speak("Form submitted successfully. Thank you!");
      assistantActive = false;
      isProcessing = false;
      const statusElement = document.getElementById("statusText");
      if (statusElement) statusElement.innerText = "✓ Form submitted! Thank you.";
    })
    .catch(error => {
      console.error("Save error:", error);
      speak("Error submitting form. Please try again.");
    });
}

/* ================= INIT ================= */
window.onload = async () => {
  console.log("Page loaded, initializing...");
  
  // Load voices
  await loadVoices();
  console.log("Voices loaded:", voices.length);
  
  // Render form
  renderForm();
  
  // Initialize chart
  initChart();
  
  // Update progress
  updateProgress();
  
  // Initialize recognition
  recognition = initRecognition();
  if (recognition) {
    setupRecognitionHandlers(recognition);
  }
  
  const startBtn = document.getElementById("startAssistant");
  const stopBtn = document.getElementById("stopAssistant");
  const muteBtn = document.getElementById("muteBtn");
  const langSelect = document.getElementById("lang");

  if (startBtn) {
    startBtn.onclick = () => {
      console.log("Start button clicked");
      if (!assistantActive && !isProcessing) {
        assistantActive = true;
        retryCount = 0;
        isProcessing = false;
        isRecognitionActive = false;
        
        recognition = initRecognition();
        if (recognition) {
          setupRecognitionHandlers(recognition);
        }
        
        speak("Assistant started. Let's fill out your form.", () => {
          setTimeout(() => promptNextField(), 500);
        });
      }
    };
  }

  if (stopBtn) {
    stopBtn.onclick = () => {
      console.log("Stop button clicked");
      assistantActive = false;
      isProcessing = false;
      isRecognitionActive = false;
      isWaitingForResponse = false;
      if (recognition) {
        try { recognition.abort(); } catch(e) {}
      }
      speechSynthesis.cancel();
      currentUtterance = null;
      speak("Assistant stopped.");
      const statusElement = document.getElementById("statusText");
      if (statusElement) statusElement.innerText = "Assistant stopped";
      
      const micIndicator = document.getElementById("micIndicator");
      const waveform = document.getElementById("waveform");
      if (micIndicator) micIndicator.classList.remove("active");
      if (waveform) waveform.classList.add("hidden");
    };
  }

  if (muteBtn) {
    muteBtn.onclick = () => {
      isMuted = !isMuted;
      muteBtn.textContent = isMuted ? "🔊 Unmute Voice" : "🔇 Mute Voice";
      if (!isMuted) speak("Voice unmuted.");
      else speechSynthesis.cancel();
    };
  }
  
  if (langSelect) {
    langSelect.addEventListener("change", () => {
      if (recognition) {
        recognition.lang = langSelect.value;
        console.log("Language changed to:", langSelect.value);
      }
    });
  }
  
  // Add manual input listeners
  fields.forEach(field => {
    if (field.type === "text" || field.type === "date") {
      const input = document.getElementById(field.id);
      if (input) {
        input.addEventListener('input', () => {
          const statusEl = document.getElementById(field.id + "_status");
          if (statusEl) {
            statusEl.innerText = input.value ? "✔ Filled" : "";
          }
          updateProgress();
        });
      }
    }
  });
  
  console.log("Initialization complete");
};