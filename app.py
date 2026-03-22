from flask import Flask, render_template, request, jsonify
import spacy
import re
from dateutil import parser as dateparser
from transformers import pipeline
from typing import Any, Dict
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)

# ================= MODELS =================
nlp = spacy.load("en_core_web_sm")

# ✅ Multilingual BERT with fallback
intent_classifier: Any = None
try:
    intent_classifier = pipeline(
        "text-classification",
        model="nlptown/bert-base-multilingual-uncased-sentiment",
        device=-1  # Force CPU for compatibility
    )
    print("✅ Loaded sentiment model: bert-base-multilingual-uncased")
except Exception as e:
    print(f"⚠️ Failed to load sentiment model: {e}")
    print("⚠️ Continuing without sentiment analysis")
    intent_classifier = None

# ✅ FIXED NER with fallback
ner_pipeline = None
try:
    ner_pipeline = pipeline(
        "token-classification",   # 🔥 use this instead of "ner"
        model="dslim/bert-base-NER",
        aggregation_strategy="simple",
        device=-1  # Force CPU
    )
    print("✅ Loaded NER model: dslim/bert-base-NER")
except Exception as e:
    print(f"⚠️ Failed to load NER model: {e}")
    print("⚠️ Continuing without transformer NER")
    ner_pipeline = None

# ================= MEMORY =================
conversation_memory: Dict = {}
confidence_history = []
accuracy_score = 0

# ================= RASA-LIKE STATE =================
dialog_state = {
    "current_slot": None,
    "last_intent": None
}

# ================= NORMALIZATION =================
def normalize_text(text):
    text = text.lower()

    replacements = {
        " at ": "@",
        " dot ": ".",
        " underscore ": "_",
        " dash ": "-"
    }

    for k, v in replacements.items():
        text = text.replace(k, v)

    return text.strip()


# ================= IMPROVED EMAIL EXTRACTION =================
def extract_email(text):
    # First, normalize the text for email patterns
    normalized_text = text.lower()
    
    # Replace spoken words with symbols
    normalized_text = re.sub(r'\s*at the rate\s*', '@', normalized_text)
    normalized_text = re.sub(r'\s*at\s*the\s*rate\s*', '@', normalized_text)
    normalized_text = re.sub(r'\s*at\s*rate\s*', '@', normalized_text)
    normalized_text = re.sub(r'\s*at\s*', '@', normalized_text)
    normalized_text = re.sub(r'\s*@\s*', '@', normalized_text)
    
    # Dot replacements
    normalized_text = re.sub(r'\s*dot\s*', '.', normalized_text)
    normalized_text = re.sub(r'\s*point\s*', '.', normalized_text)
    normalized_text = re.sub(r'\s*\.\s*', '.', normalized_text)
    
    # Remove all spaces
    normalized_text = re.sub(r'\s+', '', normalized_text)
    
    # Fix common domain patterns
    normalized_text = re.sub(r'gmail\.?com', 'gmail.com', normalized_text)
    normalized_text = re.sub(r'yahoo\.?com', 'yahoo.com', normalized_text)
    normalized_text = re.sub(r'hotmail\.?com', 'hotmail.com', normalized_text)
    normalized_text = re.sub(r'outlook\.?com', 'outlook.com', normalized_text)
    
    # Standard email regex - more permissive
    email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
    match = re.search(email_pattern, normalized_text)
    if match:
        return match.group(), 0.95
    
    # Try without @ (if it was missed)
    if '@' not in normalized_text:
        # Check if it looks like email without @
        domain_pattern = r'[a-zA-Z0-9._%+-]+(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com)'
        match = re.search(domain_pattern, normalized_text)
        if match:
            fixed = re.sub(r'([a-zA-Z0-9._%+-]+)(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com)', r'\1@\2', normalized_text)
            if re.search(email_pattern, fixed):
                return fixed, 0.85
    
    # Try original text as fallback
    match = re.search(email_pattern, text)
    if match:
        return match.group(), 0.95
    
    return None, 0


# ================= EXTRACTION =================
def extract_name(text):
    # English patterns
    match = re.search(r"(?:my name is|i am|i'm|name is|i go by)\s([a-zA-Z ]{3,})", text)
    if match:
        return match.group(1).title(), 0.9
    
    # Hinglish patterns
    match = re.search(r"(?:mera naam|naam hai)\s([a-zA-Z ]{3,})", text)
    if match:
        return match.group(1).title(), 0.85
    
    # SpaCy NER
    doc = nlp(text.title())
    for ent in doc.ents:
        if ent.label_ == "PERSON":
            return ent.text, 0.7

    return None, 0


def extract_dob(text):
    try:
        dt = dateparser.parse(text, fuzzy=True)
        if dt:
            return dt.strftime("%Y-%m-%d"), 0.85
    except:
        pass
    return None, 0


def extract_gender(text):
    text_lower = text.lower()
    if any(x in text_lower for x in ["male", "man", "boy", "ladka", "mard"]):
        return "Male", 0.9
    if any(x in text_lower for x in ["female", "woman", "girl", "ladki", "aurat"]):
        return "Female", 0.9
    if any(x in text_lower for x in ["other", "non-binary", "trans"]):
        return "Other", 0.8
    return None, 0


def extract_interests(text):
    text_lower = text.lower()
    interests = []

    if any(x in text_lower for x in ["music", "gaana", "singing", "dancing"]):
        interests.append("Music")
    if any(x in text_lower for x in ["sports", "cricket", "football", "games"]):
        interests.append("Sports")
    if any(x in text_lower for x in ["tech", "coding", "technology", "programming"]):
        interests.append("Tech")

    return (interests, 0.8) if interests else (None, 0)


def extract_rating(text):
    # Match numbers 1-5
    num = re.findall(r"\b[1-5]\b", text)
    if num:
        return (int(num[0]), 0.9)
    
    # Match word numbers
    word_to_num = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
        "ek": 1, "do": 2, "teen": 3, "char": 4, "paanch": 5
    }
    text_lower = text.lower()
    for word, num_val in word_to_num.items():
        if word in text_lower:
            return (num_val, 0.85)
    
    return None, 0


# ================= TRANSFORMER NER =================
def transformer_ner_extract(text):
    if not ner_pipeline:
        return {}
    
    try:
        entities = ner_pipeline(text)
        result = {}

        for ent in entities:
            if "entity_group" in ent:
                if ent["entity_group"] == "PER":
                    result["name"] = (ent.get("word", ""), ent.get("score", 0.5))
                elif ent["entity_group"] == "LOC":
                    # Could be used for location if needed
                    pass

        return result
    except Exception as e:
        print(f"NER extraction error: {e}")
        return {}


# ================= HYBRID =================
def hybrid_extract(text):
    data = {}
    confidence_map = {}

    functions = [
        ("name", extract_name),
        ("email", extract_email),
        ("dob", extract_dob),
        ("gender", extract_gender),
        ("interest", extract_interests),
        ("rating", extract_rating)
    ]

    for key, func in functions:
        val, conf = func(text)
        if val:
            data[key] = val
            confidence_map[key] = conf

    # Use transformer NER as fallback for name
    tf_entities = transformer_ner_extract(text)

    for key, (val, conf) in tf_entities.items():
        if key not in data or conf > confidence_map.get(key, 0):
            data[key] = val
            confidence_map[key] = conf

    return data, confidence_map


# ================= INTENT =================
def detect_intent(text):
    text_lower = text.lower()
    
    # Check for submit intent
    if any(x in text_lower for x in ["submit", "done", "finish", "complete", "submit form", "submit the form"]):
        return "SUBMIT", 0.95
    
    # Check for correction intent
    if any(x in text_lower for x in ["correct", "change", "fix", "no", "wrong", "not correct", "mistake"]):
        return "CORRECTION", 0.85
    
    # Check for help intent
    if any(x in text_lower for x in ["help", "what", "how", "confused", "stuck", "repeat"]):
        return "HELP", 0.80
    
    # Use sentiment model if available
    if intent_classifier:
        try:
            # Truncate long text
            truncated_text = text[:512]
            results = intent_classifier(truncated_text)
            
            # Handle different result formats
            if isinstance(results, list):
                if results and isinstance(results[0], dict):
                    # Take the first result if it's a list of dicts
                    best = results[0]
                    label = best.get("label", "FORM_FILL")
                    
                    # Map sentiment labels to intents
                    if label in ["1 star", "2 stars"]:
                        return "NEGATIVE", best.get("score", 0.5)
                    elif label in ["4 stars", "5 stars"]:
                        return "POSITIVE", best.get("score", 0.5)
                    else:
                        return "FORM_FILL", best.get("score", 0.5)
        except Exception as e:
            print(f"Intent classification error: {e}")

    return "FORM_FILL", 0.6


# ================= RASA-LIKE DIALOG =================
def update_dialog(intent, extracted):
    dialog_state["last_intent"] = intent

    if extracted:
        # Update current slot based on first extracted field
        dialog_state["current_slot"] = list(extracted.keys())[0]

    return dialog_state


# ================= RL-LIKE FEEDBACK =================
def update_accuracy(conf):
    global accuracy_score

    if conf > 0.7:
        accuracy_score += 0.05
    elif conf > 0.4:
        accuracy_score += 0.01
    else:
        accuracy_score -= 0.02

    # Keep accuracy between 0 and 1
    accuracy_score = max(0, min(1, accuracy_score))
    return accuracy_score


# ================= MEMORY =================
def update_memory(new_data):
    global conversation_memory
    
    # Check for corrections
    for key, value in new_data.items():
        if key in conversation_memory and conversation_memory[key] != value:
            # Store old value for correction
            conversation_memory[f"old_{key}"] = conversation_memory[key]
            conversation_memory[f"corrected_{key}"] = value
    
    conversation_memory.update(new_data)
    return conversation_memory


# ================= ROUTES =================
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/process-voice', methods=['POST'])
def process_voice():
    try:
        transcript = request.json.get('text', '')
        session_id = request.json.get('session_id', 'default')
        current_field = request.json.get('current_field', None)
        
        clean_text = normalize_text(transcript)
        print(f"Processing transcript: {clean_text}")
        print(f"Current field: {current_field}")

        extracted, confidence_map = hybrid_extract(clean_text)
        intent, intent_conf = detect_intent(clean_text)
        
        # If we're expecting email and transcript looks like an email but wasn't extracted
        if current_field == 'email' and not extracted.get('email'):
            # Check if the normalized text contains @ or looks like an email
            if '@' in clean_text or any(domain in clean_text for domain in ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com']):
                print(f"Direct email extraction attempt for: {clean_text}")
                email, conf = extract_email(clean_text)
                if email:
                    extracted['email'] = email
                    confidence_map['email'] = conf
                    print(f"Email extracted: {email}")

        dialog = update_dialog(intent, extracted)
        memory = update_memory(extracted)

        # Calculate overall confidence
        if confidence_map:
            overall_conf = sum(confidence_map.values()) / len(confidence_map)
        else:
            overall_conf = intent_conf

        # Add to confidence history (keep last 10)
        confidence_history.append(overall_conf)
        if len(confidence_history) > 10:
            confidence_history.pop(0)
        
        acc = update_accuracy(overall_conf)

        # Create response
        response = {
            "data": extracted,
            "confidence": overall_conf,
            "confidence_history": confidence_history,
            "accuracy_score": acc,
            "intent": intent,
            "memory": memory,
            "dialog_state": dialog
        }
        
        print(f"Response data: {response['data']}")
        return jsonify(response)
    
    except Exception as e:
        print(f"Error in process_voice: {e}")
        return jsonify({
            "error": str(e),
            "data": {},
            "confidence": 0.5,
            "confidence_history": confidence_history,
            "accuracy_score": accuracy_score,
            "intent": "ERROR",
            "memory": conversation_memory,
            "dialog_state": dialog_state
        }), 500


@app.route('/save', methods=['POST'])
def save():
    try:
        data = request.json
        print("Saved Data:", data)
        
        # Here you would typically save to a database
        # For now, we just log it
        
        # Reset memory after successful save (optional)
        # global conversation_memory
        # conversation_memory = {}
        
        return jsonify({
            "message": "Saved",
            "status": "success"
        })
    
    except Exception as e:
        print(f"Save error: {e}")
        return jsonify({
            "message": "Error saving data",
            "status": "error",
            "error": str(e)
        }), 500


# ================= ERROR HANDLERS =================
@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)