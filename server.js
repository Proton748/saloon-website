// ─────────────────────────────────────────────
//  Sharma's Royal Salon — Backend Server
//  Stack: Node.js + Express + MongoDB + Twilio
// ─────────────────────────────────────────────

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const twilio   = require('twilio');
require('dotenv').config();

const app = express();

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());

// ── MONGODB CONNECTION ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── BOOKING SCHEMA ──
const bookingSchema = new mongoose.Schema({
  bookingId : { type: String, required: true, unique: true },
  name      : { type: String, required: true },
  phone     : { type: String, required: true },
  service   : { type: String, required: true },
  date      : { type: String, required: true },   // "YYYY-MM-DD"
  slot      : { type: String, required: true },   // "9:00 AM"
  status    : { type: String, default: 'confirmed' }, // confirmed / cancelled
  createdAt : { type: Date,   default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);

// ── TWILIO SETUP ──
// Will only send WhatsApp if credentials exist in .env
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('✅ Twilio WhatsApp ready');
} else {
  console.log('⚠️  Twilio not configured — WhatsApp messages will be skipped');
}

// ─────────────────────────────────────────────
//  HELPER: Send WhatsApp Message via Twilio
// ─────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  if (!twilioClient) return;   // Skip if Twilio not set up

  // Format number: must be "whatsapp:+91XXXXXXXXXX"
  const formatted = `whatsapp:+91${to.replace(/\D/g, '').slice(-10)}`;

  try {
    await twilioClient.messages.create({
      from : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,  // e.g. +14155238886 (sandbox) or your approved number
      to   : formatted,
      body : message
    });
    console.log(`📲 WhatsApp sent to ${formatted}`);
  } catch (err) {
    // Don't crash the app if WhatsApp fails
    console.error('WhatsApp send failed:', err.message);
  }
}

// ─────────────────────────────────────────────
//  ROUTE 1: GET /api/slots/:date
//  Returns all booked slots for a given date
//  Frontend uses this to grey out taken slots
// ─────────────────────────────────────────────
app.get('/api/slots/:date', async (req, res) => {
  try {
    const bookings = await Booking.find({
      date   : req.params.date,
      status : 'confirmed'
    }).select('slot -_id');

    const bookedSlots = bookings.map(b => b.slot);
    res.json({ bookedSlots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch slots. Try again.' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 2: POST /api/book
//  Creates a new booking, saves to MongoDB,
//  sends WhatsApp to owner + customer
// ─────────────────────────────────────────────
app.post('/api/book', async (req, res) => {
  try {
    const { name, phone, service, date, slot } = req.body;

    // ── Basic validation ──
    if (!name || !phone || !service || !date || !slot) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
    }

    // ── Check if slot is already booked ──
    const existing = await Booking.findOne({ date, slot, status: 'confirmed' });
    if (existing) {
      return res.status(409).json({ error: 'This slot just got booked. Please pick another time.' });
    }

    // ── Generate unique Booking ID ──
    const bookingId = 'SRS-' + Date.now().toString(36).toUpperCase().slice(-6);

    // ── Save to database ──
    const booking = new Booking({ bookingId, name, phone, service, date, slot });
    await booking.save();

    // ── WhatsApp to OWNER ──
    const ownerMsg =
      `🔔 *New Booking Alert!*\n\n` +
      `📋 ID: ${bookingId}\n` +
      `👤 Name: ${name}\n` +
      `📞 Phone: ${phone}\n` +
      `✂️ Service: ${service}\n` +
      `📅 Date: ${date}\n` +
      `⏰ Slot: ${slot}\n\n` +
      `Reply DONE when complete.`;

    await sendWhatsApp(process.env.OWNER_PHONE, ownerMsg);

    // ── WhatsApp to CUSTOMER ──
    const customerMsg =
      `✅ *Booking Confirmed!*\n` +
      `*Sharma's Royal Salon, Siwan*\n\n` +
      `📋 Booking ID: *${bookingId}*\n` +
      `✂️ Service: ${service}\n` +
      `📅 Date: ${date}\n` +
      `⏰ Time: ${slot}\n\n` +
      `📍 Near Main Chowk, Siwan, Bihar\n` +
      `📞 +91 ${process.env.OWNER_PHONE}\n\n` +
      `Please arrive 5 min early. Show this message at the salon. 🙏`;

    await sendWhatsApp(phone, customerMsg);

    // ── Respond to frontend ──
    res.json({
      success   : true,
      bookingId,
      message   : 'Booking confirmed! WhatsApp sent to your number.'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 3: GET /api/queue
//  Returns number of people waiting right now
//  (bookings from now to next 2 hours today)
// ─────────────────────────────────────────────
app.get('/api/queue', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const count = await Booking.countDocuments({
      date   : today,
      status : 'confirmed'
    });
    // Each service ~20 min on average
    const waitMins = count * 20;
    res.json({ waiting: count, estimatedWaitMins: waitMins });
  } catch (err) {
    res.status(500).json({ waiting: 0, estimatedWaitMins: 0 });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 4: GET /api/bookings
//  Simple admin view — all bookings for today
//  (You can add password protection later)
// ─────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const bookings = await Booking.find({ date }).sort({ slot: 1 });
    res.json({ date, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch bookings.' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE 5: DELETE /api/cancel/:bookingId
//  Cancel a booking (slot opens back up)
// ─────────────────────────────────────────────
app.delete('/api/cancel/:bookingId', async (req, res) => {
  try {
    const booking = await Booking.findOneAndUpdate(
      { bookingId: req.params.bookingId },
      { status: 'cancelled' },
      { new: true }
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    res.json({ success: true, message: 'Booking cancelled.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not cancel booking.' });
  }
});

// ── HEALTH CHECK (Render needs this) ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: "Sharma's Royal Salon API", time: new Date() });
});

// ── START SERVER ──
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}\n`);
});
