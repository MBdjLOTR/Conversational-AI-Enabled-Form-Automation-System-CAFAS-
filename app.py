from flask import Flask, render_template, request, jsonify
import spacy
import re
from dateutil import parser as dateparser

app = Flask(__name__)
nlp = spacy.load("en_core_web_sm")


# ---------------- TRANSCRIPT NORMALIZATION ----------------
def normalize_text(text):

    text = text.lower()

    # spoken email normalization
    text = text.replace(" at ", "@")
    text = text.replace(" dot ", ".")
    text = text.replace(" underscore ", "_")
    text = text.replace(" dash ", "-")

    # remove filler words
    fillers = ["uh", "um", "hello", "hi", "okay", "ok"]
    for f in fillers:
        text = text.replace(f, "")

    return text.strip()


# ---------------- NAME EXTRACTION (RULE BASED + NER) ----------------
def extract_name(text):

    # pattern: "my name is ___"
    match = re.search(r"(?:my name is|i am|i'm)\s([a-zA-Z ]{3,})", text)
    if match:
        name = match.group(1).strip().title()
        return name

    # fallback spaCy
    doc = nlp(text.title())
    for ent in doc.ents:
        if ent.label_ == "PERSON":
            return ent.text

    return None


# ---------------- EMAIL ----------------
def extract_email(text):
    email_pattern = r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}"
    match = re.search(email_pattern, text)
    return match.group() if match else None


# ---------------- DOB ----------------
def extract_dob(text):

    # detect birth phrases
    dob_patterns = [
        r"(?:born on|date of birth is|dob is|i was born on)\s(.+)",
    ]

    for pattern in dob_patterns:
        match = re.search(pattern, text)
        if match:
            try:
                dt = dateparser.parse(match.group(1), fuzzy=True)
                return dt.strftime("%Y-%m-%d")
            except:
                pass

    # fallback generic date detection
    try:
        dt = dateparser.parse(text, fuzzy=True)
        if dt.year < 2020:   # avoid today's date detection
            return dt.strftime("%Y-%m-%d")
    except:
        return None

    return None


# ---------------- GENDER ----------------
def extract_gender(text):
    if "female" in text:
        return "Female"
    if "male" in text:
        return "Male"
    if "other" in text:
        return "Other"
    return None


# ---------------- INTERESTS ----------------
def extract_interests(text):
    interests = []
    if "music" in text: interests.append("Music")
    if "sports" in text or "cricket" in text or "football" in text: interests.append("Sports")
    if "tech" in text or "coding" in text or "programming" in text: interests.append("Tech")
    return interests


# ---------------- RATING ----------------
def extract_rating(text):

    words = {
        "one":1,"two":2,"three":3,"four":4,"five":5
    }

    num = re.findall(r"\b[1-5]\b", text)
    if num:
        return int(num[0])

    for w,v in words.items():
        if w in text:
            return v

    return None


# ---------------- ROUTE ----------------
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/process-voice', methods=['POST'])
def process_voice():

    transcript = request.json.get('text', '')
    clean_text = normalize_text(transcript)

    extracted = {}

    name = extract_name(clean_text)
    if name:
        extracted["fullName"] = name

    email = extract_email(clean_text)
    if email:
        extracted["email"] = email

    dob = extract_dob(clean_text)
    if dob:
        extracted["dob"] = dob

    gender = extract_gender(clean_text)
    if gender:
        extracted["gender"] = gender

    interests = extract_interests(clean_text)
    if interests:
        extracted["interests"] = interests

    rating = extract_rating(clean_text)
    if rating:
        extracted["satisfaction"] = rating

    return jsonify({
        "data": extracted,
        "status": "Mapped successfully" if extracted else "No clear data found",
        "raw_transcript": transcript
    })


if __name__ == '__main__':
    app.run(debug=True)
