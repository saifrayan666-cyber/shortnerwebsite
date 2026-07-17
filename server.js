// server.js - SQLite Version (No MongoDB needed)
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ============ SQLite Database Setup ============
const db = new sqlite3.Database('./database.db');

// Create tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegramId TEXT UNIQUE,
        name TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastSeen DATETIME DEFAULT CURRENT_TIMESTAMP,
        isOnline INTEGER DEFAULT 0
    )`);

    // Links table
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

console.log('✅ SQLite database created successfully!');

// ============ Middleware ============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 7,
        secure: process.env.NODE_ENV === 'production'
    }
}));

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
    res.render('index', { page: 'home' });
});

// Login
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('index', { page: 'login' });
});

app.post('/login', (req, res) => {
    const { telegramId, username } = req.body;
    
    if (!telegramId || !username) {
        return res.render('index', {
            page: 'login',
            error: 'Please provide both Telegram ID and Name'
        });
    }

    db.get('SELECT * FROM users WHERE telegramId = ?', [telegramId], (err, user) => {
        if (err) {
            return res.render('index', { page: 'login', error: 'Database error' });
        }

        if (user) {
            db.run('UPDATE users SET name = ?, lastSeen = CURRENT_TIMESTAMP, isOnline = 1 WHERE id = ?', 
                [username, user.id], (err) => {
                    if (err) {
                        return res.render('index', { page: 'login', error: 'Update failed' });
                    }
                    req.session.user = { id: user.id, name: username };
                    res.redirect('/');
                });
        } else {
            db.run('INSERT INTO users (telegramId, name, isOnline) VALUES (?, ?, 1)',
                [telegramId, username], function(err) {
                    if (err) {
                        return res.render('index', { page: 'login', error: 'Registration failed' });
                    }
                    req.session.user = { id: this.lastID, name: username };
                    res.redirect('/');
                });
        }
    });
});

// Logout
app.post('/logout', (req, res) => {
    if (req.session.user) {
        db.run('UPDATE users SET isOnline = 0 WHERE id = ?', [req.session.user.id]);
    }
    req.session.destroy();
    res.redirect('/');
});

// Dashboard
app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    db.run('UPDATE users SET isOnline = 1, lastSeen = CURRENT_TIMESTAMP WHERE id = ?', 
        [req.session.user.id]);

    db.all('SELECT * FROM links WHERE userId = ? ORDER BY createdAt DESC', 
        [req.session.user.id], (err, links) => {
            if (err) {
                return res.redirect('/');
            }

            const totalClicks = links.reduce((sum, link) => sum + link.clicks, 0);
            
            // Get user's links with shortUrl
            const linksWithUrl = links.map(link => ({
                ...link,
                shortUrl: `${BASE_URL}/${link.shortCode}`
            }));

            getOnlineUsers((count, users) => {
                res.render('index', {
                    page: 'dashboard',
                    user: req.session.user,
                    links: linksWithUrl,
                    totalClicks,
                    onlineUsers: count,
                    onlineUserList: users
                });
            });
        });
});

// Shorten Link
app.post('/shorten', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const { originalUrl, customSlug } = req.body;
    let shortCode = customSlug || generateShortCode();

    db.get('SELECT * FROM links WHERE shortCode = ?', [shortCode], (err, existing) => {
        if (err) {
            return res.render('index', { page: 'home', error: 'Database error' });
        }

        if (existing) {
            if (customSlug) {
                return res.render('index', { 
                    page: 'home', 
                    error: `"${customSlug}" is already taken. Please choose another.` 
                });
            }
            shortCode = generateShortCode();
        }

        db.run('INSERT INTO links (shortCode, originalUrl, userId) VALUES (?, ?, ?)',
            [shortCode, originalUrl, req.session.user.id], function(err) {
                if (err) {
                    return res.render('index', { page: 'home', error: 'Failed to create link' });
                }

                const shortUrl = `${BASE_URL}/${shortCode}`;
                res.render('index', {
                    page: 'home',
                    shortUrl,
                    success: 'Link created successfully!'
                });
            });
    });
});

// Redirect
app.get('/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    
    const routes = ['login', 'dashboard', 'logout', 'shorten', 'update-link', 'delete-link', 'api'];
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
    db.run('UPDATE links SET originalUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?',
        [newUrl, req.params.id, req.session.user.id], (err) => {
            res.redirect('/dashboard');
        });
});

// Delete Link
app.post('/delete-link/:id', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    db.run('DELETE FROM links WHERE id = ? AND userId = ?', 
        [req.params.id, req.session.user.id], (err) => {
            res.redirect('/dashboard');
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

// ============ Start Server ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Base URL: ${BASE_URL}`);
    console.log(`📦 Database: SQLite (No MongoDB needed)`);
    console.log(`✅ Ready to use!`);
});
