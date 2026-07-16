// server.js - Main Application File (Telegram Login Only)
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/shortlink';
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-key-change-in-production';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ============ MIDDLEWARE ============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGODB_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

// Make data available in all templates
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.page = req.path === '/' ? 'home' : req.path.slice(1);
    res.locals.onlineUsers = getOnlineUserCount();
    res.locals.onlineUserList = getOnlineUsers();
    next();
});

// ============ DATABASE MODELS ============
mongoose.connect(MONGODB_URI);

// User Schema (Telegram users)
const UserSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    isOnline: { type: Boolean, default: false }
});

const User = mongoose.model('User', UserSchema);

// Link Schema
const LinkSchema = new mongoose.Schema({
    shortCode: { type: String, required: true, unique: true },
    originalUrl: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clicks: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const Link = mongoose.model('Link', LinkSchema);

// ============ ONLINE USERS TRACKING ============
let onlineUsers = new Map(); // userId -> { name, lastSeen }

// Clean up inactive users every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of onlineUsers) {
        if (now - data.lastSeen > 60000) { // 1 minute timeout
            onlineUsers.delete(id);
        }
    }
}, 30000);

function getOnlineUserCount() {
    return onlineUsers.size;
}

function getOnlineUsers() {
    return Array.from(onlineUsers.values());
}

function updateUserOnline(userId, name) {
    onlineUsers.set(userId.toString(), { 
        id: userId.toString(),
        name: name,
        lastSeen: Date.now() 
    });
}

// ============ HELPER FUNCTIONS ============
function generateShortCode() {
    return crypto.randomBytes(4).toString('hex');
}

// ============ ROUTES ============

// Home
app.get('/', async (req, res) => {
    res.render('index', { page: 'home' });
});

// Login Page
app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('index', { page: 'login' });
});

// Login with Telegram
app.post('/login', async (req, res) => {
    try {
        const { telegramId, username } = req.body;
        
        if (!telegramId || !username) {
            return res.render('index', {
                page: 'login',
                error: 'Please provide both Telegram ID and Name'
            });
        }

        // Find or create user
        let user = await User.findOne({ telegramId });
        
        if (!user) {
            user = new User({
                telegramId,
                name: username,
                lastSeen: new Date(),
                isOnline: true
            });
            await user.save();
        } else {
            // Update existing user
            user.name = username;
            user.lastSeen = new Date();
            user.isOnline = true;
            await user.save();
        }

        // Set session
        req.session.user = {
            id: user._id,
            telegramId: user.telegramId,
            name: user.name
        };

        // Add to online users
        updateUserOnline(user._id, user.name);

        res.redirect('/');
    } catch (error) {
        console.error('Login error:', error);
        res.render('index', {
            page: 'login',
            error: 'Login failed. Please try again.'
        });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    if (req.session.user) {
        try {
            await User.findByIdAndUpdate(req.session.user.id, { isOnline: false });
        } catch (e) {}
        onlineUsers.delete(req.session.user.id.toString());
    }
    req.session.destroy();
    res.redirect('/');
});

// Dashboard
app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    try {
        const links = await Link.find({ userId: req.session.user.id }).sort({ createdAt: -1 });
        
        const linksWithUrl = await Promise.all(links.map(async link => {
            const user = await User.findById(link.userId);
            return {
                ...link.toObject(),
                shortUrl: `${BASE_URL}/${link.shortCode}`,
                creatorName: user ? user.name : 'Unknown',
                creatorId: link.userId.toString()
            };
        }));

        const totalClicks = links.reduce((sum, link) => sum + link.clicks, 0);

        // Update user online status
        updateUserOnline(req.session.user.id, req.session.user.name);

        res.render('index', {
            page: 'dashboard',
            links: linksWithUrl,
            totalClicks,
            user: req.session.user
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.redirect('/');
    }
});

// Shorten Link
app.post('/shorten', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    try {
        const { originalUrl, customSlug } = req.body;
        
        let shortCode = customSlug || generateShortCode();
        
        let existingLink = await Link.findOne({ shortCode });
        if (existingLink) {
            if (customSlug) {
                return res.render('index', {
                    page: 'home',
                    error: `"${customSlug}" is already taken. Please choose another.`
                });
            }
            shortCode = generateShortCode();
        }

        const link = new Link({
            shortCode,
            originalUrl,
            userId: req.session.user.id
        });

        await link.save();

        const shortUrl = `${BASE_URL}/${shortCode}`;
        
        res.render('index', {
            page: 'home',
            shortUrl,
            success: 'Link created successfully!'
        });
    } catch (error) {
        console.error('Shorten error:', error);
        res.render('index', {
            page: 'home',
            error: 'Failed to create short link. Please try again.'
        });
    }
});

// Redirect to original URL
app.get('/:shortCode', async (req, res) => {
    try {
        const { shortCode } = req.params;
        
        const routes = ['login', 'dashboard', 'logout', 'shorten', 'update-link', 'delete-link', 'api'];
        if (routes.includes(shortCode)) {
            return res.redirect('/');
        }

        const link = await Link.findOne({ shortCode });
        if (!link) {
            return res.status(404).send('Link not found');
        }

        link.clicks += 1;
        await link.save();

        res.redirect(link.originalUrl);
    } catch (error) {
        console.error('Redirect error:', error);
        res.status(500).send('Server error');
    }
});

// Update Link
app.post('/update-link/:id', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    try {
        const { id } = req.params;
        const { newUrl } = req.body;
        
        const link = await Link.findOne({ _id: id, userId: req.session.user.id });
        if (!link) {
            return res.redirect('/dashboard');
        }

        link.originalUrl = newUrl;
        link.updatedAt = new Date();
        await link.save();

        res.redirect('/dashboard');
    } catch (error) {
        console.error('Update error:', error);
        res.redirect('/dashboard');
    }
});

// Delete Link
app.post('/delete-link/:id', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    try {
        const { id } = req.params;
        await Link.findOneAndDelete({ _id: id, userId: req.session.user.id });
        res.redirect('/dashboard');
    } catch (error) {
        console.error('Delete error:', error);
        res.redirect('/dashboard');
    }
});

// ============ API ROUTES ============

// Get online users (for AJAX updates)
app.get('/api/online-users', (req, res) => {
    res.json({
        count: getOnlineUserCount(),
        users: getOnlineUsers()
    });
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Base URL: ${BASE_URL}`);
    console.log(`📱 Login with Telegram ID required`);
});
