// server.js - With Telegram ID Validation
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // For Telegram API calls

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ===== TELEGRAM BOT CONFIG =====
// You need to create a bot and get the token from @BotFather
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; // Set this in Railway Variables
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

console.log('🔧 Configuration:');
console.log(`📦 TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? '✅ Set' : '❌ Not Set - Validation will be disabled'}`);

// ============ Setup ============
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure views directory exists
const viewsDir = path.join(__dirname, 'views');
if (!fs.existsSync(viewsDir)) {
    fs.mkdirSync(viewsDir, { recursive: true });
}

// ============ SQLite Database ============
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('❌ Database error:', err.message);
    } else {
        console.log('✅ SQLite database connected');
    }
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegramId TEXT UNIQUE,
        name TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastSeen DATETIME DEFAULT CURRENT_TIMESTAMP,
        isOnline INTEGER DEFAULT 0,
        isValidated INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shortCode TEXT UNIQUE,
        originalUrl TEXT,
        userId INTEGER,
        clicks INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(userId) REFERENCES users(id)
    )`);
});

// ============ Middleware ============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: true,
    saveUninitialized: true,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 7,
        secure: false,
        httpOnly: true
    }
}));

// ============ TELEGRAM VALIDATION FUNCTION ============
async function validateTelegramId(telegramId, username) {
    // If no bot token, skip validation (for testing)
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('⚠️ No bot token set, skipping validation');
        return { valid: true, name: username };
    }

    try {
        // Method 1: Try to get user info from Telegram API
        const response = await axios.get(`${TELEGRAM_API_URL}/getChat`, {
            params: { chat_id: telegramId }
        });

        if (response.data && response.data.ok) {
            const user = response.data.result;
            return { 
                valid: true, 
                name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
                username: user.username || username
            };
        }
        return { valid: false, error: 'Invalid Telegram ID' };
    } catch (error) {
        // Method 2: Alternative check - try to send a message
        try {
            const testMessage = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                chat_id: telegramId,
                text: '🔐 This is a validation test from Shortlink Pro. If you see this, your ID is valid!',
                disable_notification: true
            });

            if (testMessage.data && testMessage.data.ok) {
                return { valid: true, name: username };
            }
            return { valid: false, error: 'Cannot reach this Telegram user' };
        } catch (sendError) {
            console.log('❌ Telegram validation failed:', sendError.message);
            return { 
                valid: false, 
                error: 'Invalid Telegram ID. Please make sure you entered the correct ID.' 
            };
        }
    }
}

// ============ Helper Functions ============
function getOnlineUsers(callback) {
    db.all('SELECT name FROM users WHERE isOnline = 1', (err, users) => {
        if (err) return callback(0, []);
        callback(users ? users.length : 0, users || []);
    });
}

function generateShortCode() {
    return crypto.randomBytes(4).toString('hex');
}

// ============ Middleware for templates ============
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.page = req.path === '/' ? 'home' : req.path.slice(1);
    
    getOnlineUsers((count, users) => {
        res.locals.onlineUsers = count;
        res.locals.onlineUserList = users;
        next();
    });
});

// ============ Routes ============

// Home
app.get('/', (req, res) => {
    res.render('index', { 
        page: 'home',
        error: null,
        success: null,
        info: null,
        shortUrl: null
    });
});

// Login
app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('index', { 
        page: 'login',
        error: null,
        success: null,
        info: null
    });
});

// Login with Telegram Validation
app.post('/login', async (req, res) => {
    const { telegramId, username } = req.body;
    
    console.log('📱 Login attempt:', { telegramId, username });
    
    if (!telegramId || !username) {
        return res.render('index', {
            page: 'login',
            error: 'Please provide both Telegram ID and Name',
            success: null,
            info: null
        });
    }

    // ===== STEP 1: Validate Telegram ID =====
    console.log('🔍 Validating Telegram ID...');
    const validation = await validateTelegramId(telegramId, username);
    
    if (!validation.valid) {
        console.log('❌ Validation failed:', validation.error);
        return res.render('index', {
            page: 'login',
            error: validation.error || 'Invalid Telegram ID. Please check and try again.',
            success: null,
            info: null
        });
    }

    console.log('✅ Telegram ID validated successfully!');

    // ===== STEP 2: Check if user exists in database =====
    db.get('SELECT * FROM users WHERE telegramId = ?', [telegramId], (err, user) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.render('index', { 
                page: 'login', 
                error: 'Database error. Please try again.',
                success: null,
                info: null
            });
        }

        if (user) {
            // Update existing user
            db.run('UPDATE users SET name = ?, lastSeen = CURRENT_TIMESTAMP, isOnline = 1, isValidated = 1 WHERE id = ?', 
                [validation.name || username, user.id], (err) => {
                    if (err) {
                        console.error('❌ Update error:', err);
                        return res.render('index', { 
                            page: 'login', 
                            error: 'Update failed. Please try again.',
                            success: null,
                            info: null
                        });
                    }
                    req.session.user = { 
                        id: user.id, 
                        name: validation.name || username,
                        telegramId: telegramId
                    };
                    req.session.save((err) => {
                        if (err) console.error('Session save error:', err);
                        console.log('✅ User logged in:', username);
                        res.redirect('/dashboard');
                    });
                });
        } else {
            // Create new validated user
            db.run('INSERT INTO users (telegramId, name, isOnline, isValidated) VALUES (?, ?, 1, 1)',
                [telegramId, validation.name || username], function(err) {
                    if (err) {
                        console.error('❌ Registration error:', err);
                        return res.render('index', { 
                            page: 'login', 
                            error: 'Registration failed. Please try again.',
                            success: null,
                            info: null
                        });
                    }
                    req.session.user = { 
                        id: this.lastID, 
                        name: validation.name || username,
                        telegramId: telegramId
                    };
                    req.session.save((err) => {
                        if (err) console.error('Session save error:', err);
                        console.log('✅ New validated user registered:', username);
                        res.redirect('/dashboard');
                    });
                });
        }
    });
});

// Logout
app.post('/logout', (req, res) => {
    if (req.session.user) {
        db.run('UPDATE users SET isOnline = 0 WHERE id = ?', [req.session.user.id]);
    }
    req.session.destroy((err) => {
        if (err) console.error('Session destroy error:', err);
        res.redirect('/');
    });
});

// Dashboard
app.get('/dashboard', (req, res) => {
    console.log('📊 Dashboard access, user:', req.session.user);
    
    if (!req.session.user) {
        console.log('❌ No user in session, redirecting to login');
        return res.redirect('/login');
    }

    db.run('UPDATE users SET isOnline = 1, lastSeen = CURRENT_TIMESTAMP WHERE id = ?', 
        [req.session.user.id]);

    db.all('SELECT * FROM links WHERE userId = ? ORDER BY createdAt DESC', 
        [req.session.user.id], (err, links) => {
            if (err) {
                console.error('❌ Links fetch error:', err);
                return res.redirect('/');
            }

            console.log(`📊 Found ${links.length} links for user`);

            const totalClicks = links.reduce((sum, link) => sum + link.clicks, 0);
            
            const linksWithUrl = links.map(link => ({
                ...link,
                shortUrl: `${BASE_URL}/${link.shortCode}`
            }));

            getOnlineUsers((count, users) => {
                res.render('index', {
                    page: 'dashboard',
                    user: req.session.user,
                    links: linksWithUrl,
                    totalClicks: totalClicks,
                    onlineUsers: count,
                    onlineUserList: users,
                    error: null,
                    success: null,
                    info: null,
                    shortUrl: null
                });
            });
        });
});

// Shorten Link
app.post('/shorten', (req, res) => {
    console.log('🔗 Shorten request, user:', req.session.user);
    
    if (!req.session.user) {
        console.log('❌ No user in session');
        return res.redirect('/login');
    }

    const { originalUrl, customSlug } = req.body;
    
    if (!originalUrl) {
        const errorMsg = 'Please provide a URL';
        if (req.headers.referer && req.headers.referer.includes('/dashboard')) {
            return res.redirect('/dashboard?error=' + encodeURIComponent(errorMsg));
        }
        return res.render('index', { 
            page: 'home', 
            error: errorMsg,
            success: null,
            info: null,
            shortUrl: null
        });
    }

    let shortCode = customSlug || generateShortCode();

    db.get('SELECT * FROM links WHERE shortCode = ?', [shortCode], (err, existing) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.redirect('/dashboard?error=Database error');
        }

        if (existing) {
            if (customSlug) {
                const errorMsg = `"${customSlug}" is already taken`;
                if (req.headers.referer && req.headers.referer.includes('/dashboard')) {
                    return res.redirect('/dashboard?error=' + encodeURIComponent(errorMsg));
                }
                return res.render('index', { 
                    page: 'home', 
                    error: errorMsg,
                    success: null,
                    info: null,
                    shortUrl: null
                });
            }
            shortCode = generateShortCode();
        }

        db.run('INSERT INTO links (shortCode, originalUrl, userId) VALUES (?, ?, ?)',
            [shortCode, originalUrl, req.session.user.id], function(err) {
                if (err) {
                    console.error('❌ Insert error:', err);
                    return res.redirect('/dashboard?error=Failed to create link');
                }

                const shortUrl = `${BASE_URL}/${shortCode}`;
                console.log('✅ Link created:', shortUrl);
                
                res.redirect('/dashboard?success=' + encodeURIComponent('Link created successfully!'));
            });
    });
});

// Redirect to original URL
app.get('/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    
    const routes = ['login', 'dashboard', 'logout', 'shorten', 'update-link', 'delete-link', 'api', 'signup'];
    if (routes.includes(shortCode)) {
        return res.redirect('/');
    }

    db.get('SELECT * FROM links WHERE shortCode = ?', [shortCode], (err, link) => {
        if (err || !link) {
            return res.status(404).send('Link not found');
        }

        db.run('UPDATE links SET clicks = clicks + 1 WHERE id = ?', [link.id]);
        res.redirect(link.originalUrl);
    });
});

// Update Link
app.post('/update-link/:id', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const { newUrl } = req.body;
    
    if (!newUrl) {
        return res.redirect('/dashboard?error=Please provide a new URL');
    }

    db.run('UPDATE links SET originalUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?',
        [newUrl, req.params.id, req.session.user.id], (err) => {
            if (err) {
                console.error('❌ Update error:', err);
                return res.redirect('/dashboard?error=Update failed');
            }
            res.redirect('/dashboard?success=Link updated successfully!');
        });
});

// Delete Link
app.post('/delete-link/:id', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    db.run('DELETE FROM links WHERE id = ? AND userId = ?', 
        [req.params.id, req.session.user.id], (err) => {
            if (err) {
                console.error('❌ Delete error:', err);
                return res.redirect('/dashboard?error=Delete failed');
            }
            res.redirect('/dashboard?success=Link deleted successfully!');
        });
});

// API - Online users
app.get('/api/online-users', (req, res) => {
    db.all('SELECT name FROM users WHERE isOnline = 1', (err, users) => {
        res.json({
            count: users ? users.length : 0,
            users: users || []
        });
    });
});

// ============ Error Handler ============
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err.message);
    res.status(500).send('Something went wrong! Check server logs.');
});

// ============ Start Server ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Base URL: ${BASE_URL}`);
    console.log(`📦 Database: SQLite`);
    console.log(`📱 Telegram Validation: ${TELEGRAM_BOT_TOKEN ? '✅ Enabled' : '❌ Disabled (set TELEGRAM_BOT_TOKEN)'}`);
    console.log(`✅ Ready to use!`);
});
