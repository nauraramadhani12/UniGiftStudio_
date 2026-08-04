/**
 * UniGift Studio - Backend Server (ALL-IN-ONE)
 * Stack: Node.js + Express + MySQL2 + CORS + JWT
 *
 * Cara jalanin:
 *   node server.js
 *   Server jalan di http://localhost:3000
 *
 * ── Route Map ────────────────────────────────────────────────────────
 *  SELLER / CONSUMER (tanpa auth)
 *    GET    /api/products
 *    GET    /api/orders
 *    GET    /api/stats
 *    GET    /api/user/:userId/addresses
 *    PATCH  /api/orders/:id/status
 *    POST   /api/ai-request
 *
 *  ADMIN (butuh Bearer token)
 *    POST   /api/auth/login
 *    GET    /api/admin/dashboard
 *    GET    /api/admin/users
 *    GET    /api/admin/users/:id
 *    PUT    /api/admin/users/:id
 *    PATCH  /api/admin/users/:id/status
 *    DELETE /api/admin/users/:id
 *    GET    /api/admin/products
 *    GET    /api/admin/products/:id
 *    POST   /api/admin/products
 *    PUT    /api/admin/products/:id
 *    PATCH  /api/admin/products/:id/status
 *    DELETE /api/admin/products/:id
 *    GET    /api/admin/orders
 *    GET    /api/admin/orders/:id
 *    PATCH  /api/admin/orders/:id/status
 * ─────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

// Baca file .env secara manual (tanpa dependency dotenv) —
// dipakai di hosting untuk kredensial database (DB_HOST, DB_USER, dst.)
for (const envPath of [path.join(__dirname, '../.env'), path.join(__dirname, '.env')]) {
    try {
        if (fs.existsSync(envPath)) {
            fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
                const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
                if (m && process.env[m[1]] === undefined) {
                    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
                }
            });
            break;
        }
    } catch { /* abaikan, pakai fallback default */ }
}

const app = express();
app.set('trust proxy', true); // di hosting (LiteSpeed) → req.protocol ikut https, URL upload tidak mixed-content
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'unigiftstudio_secret_key_ganti_ini';

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Simpan file dari data URL base64 (tanpa dependency eksternal)
function saveBase64File(dataUrl, origName) {
    const m = /^data:([a-z0-9.+\/-]+);base64,(.+)$/i.exec(dataUrl || '');
    if (!m) return null;
    let ext;
    if (m[1].startsWith('image/')) {
        ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
    } else {
        // File non-gambar (mis. .stl/.obj desain 3D) — ambil ekstensi dari nama file asli
        ext = (path.extname(origName || '').slice(1) || 'bin').toLowerCase();
    }
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = `${uniqueSuffix}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(m[2], 'base64'));
    return filename;
}

// Multer — untuk upload multipart/FormData (dipakai file consumer versi lama).
// Endpoint upload menerima DUA cara sekaligus: FormData (multer) & base64 JSON.
let multerUpload = null;
try {
    const multer = require('multer');
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, suffix + (path.extname(file.originalname) || '.png'));
        }
    });
    multerUpload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
} catch (e) {
    console.warn('multer tidak tersedia, upload hanya via base64 JSON:', e.message);
}

// Middleware upload fleksibel: jalankan multer kalau request multipart, kalau tidak lewati saja.
function terimaUpload(fieldName) {
    return (req, res, next) => {
        const ct = req.headers['content-type'] || '';
        if (multerUpload && ct.includes('multipart/form-data')) {
            return multerUpload.single(fieldName)(req, res, next);
        }
        next();
    };
}

// Ambil URL file hasil upload — dari multer (req.file) ATAU base64 (req.body.data).
// URL absolут dgn protokol benar (trust proxy → https di hosting, http di localhost).
function resolveUploadedFile(req) {
    let filename = null;
    if (req.file) filename = req.file.filename;
    else if (req.body && req.body.data) filename = saveBase64File(req.body.data, req.body.filename);
    if (!filename) return null;
    return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

/* ==========================================================
 * 1. MIDDLEWARE GLOBAL
 * ========================================================== */
app.use(cors());
app.use(express.json({ limit: '10mb' })); // limit besar untuk upload foto base64
app.use('/uploads', express.static(uploadDir));

// Larang cache (LiteSpeed/browser) untuk semua respons API —
// tanpa ini, produk/pesanan baru bisa telat muncul beberapa menit di hosting
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
});

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

/* ==========================================================
 * 2. KONEKSI DATABASE
 * ========================================================== */
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'unigiftstudio',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

(async() => {
    try {
        const conn = await pool.getConnection();
        console.log('✓ Terhubung ke MySQL database: unigiftstudio');
        // Migration: tambah payment_group jika belum ada
        await conn.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_group VARCHAR(20) DEFAULT NULL`);
        // Migration: bukti pembayaran (upload bukti transfer saat bayar)
        await conn.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bukti_pembayaran VARCHAR(255) DEFAULT NULL`);
        // Migration: varian item keranjang
        await conn.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS varian VARCHAR(100) DEFAULT NULL`);
        // Migration: varian & teks kustom yang diatur kreator per produk
        await conn.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS varian_label VARCHAR(100) DEFAULT NULL`);
        await conn.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS varian_opsi TEXT DEFAULT NULL`);
        await conn.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS teks_kustom_max INT DEFAULT 0`);
        await conn.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS teks_kustom VARCHAR(100) DEFAULT NULL`);
        conn.release();
    } catch (err) {
        console.error('✗ Gagal koneksi DB:', err.message);
        process.exit(1);
    }
})();

// Wrapper async error → otomatis ke error handler
const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/* ==========================================================
 * 3. MIDDLEWARE AUTH (inline, tanpa file terpisah)
 * ========================================================== */
const verifyAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token tidak ditemukan.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Akses ditolak. Hanya admin.' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Token tidak valid atau kadaluarsa.' });
    }
};

/* ==========================================================
 * 4. AUTH — LOGIN & REGISTER
 * ========================================================== */

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Response: { success, token, user }
 */
app.post('/api/auth/login', asyncHandler(async(req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
    }

    const [rows] = await pool.query(
        'SELECT id, nama_lengkap, email, password, role, status_akun FROM users WHERE email = ?', [email]
    );

    if (rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Email tidak ditemukan.' });
    }

    const user = rows[0];

    if (user.status_akun === 'diblokir') {
        return res.status(403).json({ success: false, message: 'Akun kamu diblokir.' });
    }

    // Support plain text password (sesuai data awal database)
    if (password !== user.password) {
        return res.status(401).json({ success: false, message: 'Password salah.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role },
        JWT_SECRET, { expiresIn: '7d' }
    );

    res.json({
        success: true,
        message: 'Login berhasil.',
        token,
        user: { id: user.id, nama_lengkap: user.nama_lengkap, email: user.email, role: user.role }
    });
}));

/**
 * POST /api/auth/register
 * Body: { nama_lengkap, email, password, role: 'consumer'|'creator' }
 */
app.post('/api/auth/register', asyncHandler(async(req, res) => {
    const { nama_lengkap, email, password, role } = req.body;

    if (!nama_lengkap || !email || !password) {
        return res.status(400).json({ success: false, message: 'Nama, email, dan password wajib diisi.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });
    }

    // Map role dari frontend ke enum database
    const roleMap = { consumer: 'pelanggan', creator: 'kreator' };
    const dbRole = roleMap[role] || 'pelanggan';

    // Cek email sudah terdaftar
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
        return res.status(409).json({ success: false, message: 'Email sudah terdaftar. Silakan login.' });
    }

    const [result] = await pool.query(
        'INSERT INTO users (nama_lengkap, email, password, role, status_akun) VALUES (?, ?, ?, ?, ?)', [nama_lengkap.trim(), email.trim(), password, dbRole, 'aktif']
    );

    res.status(201).json({
        success: true,
        message: 'Akun berhasil dibuat! Silakan login.',
        id: result.insertId
    });
}));

/* ==========================================================
 * 5. ROUTES — ADMIN DASHBOARD
 * ========================================================== */

/**
 * GET /api/admin/dashboard
 * Statistik lengkap untuk dashboard_admin.html
 */
app.get('/api/admin/dashboard', verifyAdmin, asyncHandler(async(req, res) => {
    const [
        [{ totalPelanggan }]
    ] = await pool.query(
        "SELECT COUNT(*) AS totalPelanggan FROM users WHERE role = 'pelanggan'"
    );
    const [
        [{ totalProduk }]
    ] = await pool.query(
        "SELECT COUNT(*) AS totalProduk FROM products WHERE status_produk = 'aktif'"
    );
    const [
        [{ pesananHariIni }]
    ] = await pool.query(
        "SELECT COUNT(*) AS pesananHariIni FROM orders WHERE DATE(created_at) = CURDATE()"
    );
    const [
        [{ totalRevenue }]
    ] = await pool.query(
        "SELECT COALESCE(SUM(total_bayar), 0) AS totalRevenue FROM orders WHERE status_pesanan IN ('diproses','dikirim','selesai')"
    );
    const [statusStats] = await pool.query(
        'SELECT status_pesanan, COUNT(*) AS jumlah FROM orders GROUP BY status_pesanan'
    );
    const [recentOrders] = await pool.query(
        `SELECT o.id, o.kode_pesanan, o.nama_penerima, o.total_bayar, o.status_pesanan, o.created_at,
                u.nama_lengkap AS nama_user
         FROM orders o LEFT JOIN users u ON o.user_id = u.id
         ORDER BY o.created_at DESC LIMIT 7`
    );
    const [stokRendah] = await pool.query(
        'SELECT id, kode_produk, nama_produk, stok FROM products WHERE stok < 5 ORDER BY stok ASC'
    );
    const [
        [{ kontributorPending }]
    ] = await pool.query(
        "SELECT COUNT(*) AS kontributorPending FROM contributors WHERE status = 'pending'"
    );
    const [
        [{ totalAiRequests }]
    ] = await pool.query(
        "SELECT COUNT(*) AS totalAiRequests FROM ai_custom_designs"
    );

    res.json({
        success: true,
        data: { totalPelanggan, totalProduk, pesananHariIni, totalRevenue, statusStats, recentOrders, stokRendah, kontributorPending, totalAiRequests }
    });
}));

/**
 * GET /api/admin/sales-chart
 * Data penjualan 6 bulan terakhir: total order + total revenue per bulan
 */
app.get('/api/admin/sales-chart', verifyAdmin, asyncHandler(async(req, res) => {
    const [rows] = await pool.query(`
        SELECT
            DATE_FORMAT(created_at, '%Y-%m') AS bulan,
            DATE_FORMAT(created_at, '%b %Y')  AS label,
            COUNT(*) AS total_pesanan,
            SUM(total_bayar) AS total_revenue,
            SUM(CASE WHEN status_pesanan = 'selesai' THEN total_bayar ELSE 0 END) AS revenue_selesai
        FROM orders
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
        GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b %Y')
        ORDER BY bulan ASC
    `);
    res.json({ success: true, data: rows });
}));

/**
 * GET /api/admin/top-products
 * Produk terlaris berdasarkan jumlah terjual
 */
app.get('/api/admin/top-products', verifyAdmin, asyncHandler(async(req, res) => {
    const [rows] = await pool.query(`
        SELECT p.nama_produk, p.kategori, p.foto_url,
               SUM(oi.kuantitas) AS total_terjual,
               SUM(oi.kuantitas * oi.harga_satuan) AS total_revenue
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        GROUP BY p.id, p.nama_produk, p.kategori, p.foto_url
        ORDER BY total_terjual DESC
        LIMIT 5
    `);
    res.json({ success: true, data: rows });
}));

/* ==========================================================
 * 6. ROUTES — ADMIN USERS (admin-pengguna.html & admin-edit-pengguna.html)
 * ========================================================== */

// GET semua pengguna
app.get('/api/admin/users', verifyAdmin, asyncHandler(async(req, res) => {
    const { role, status, search } = req.query;
    let query = 'SELECT id, nama_lengkap, email, role, status_akun, created_at FROM users WHERE 1=1';
    const params = [];

    if (role) {
        query += ' AND role = ?';
        params.push(role);
    }
    if (status) {
        query += ' AND status_akun = ?';
        params.push(status);
    }
    if (search) {
        query += ' AND (nama_lengkap LIKE ? OR email LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
}));

// GET detail satu pengguna
app.get('/api/admin/users/:id', verifyAdmin, asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        'SELECT id, nama_lengkap, email, role, status_akun, created_at FROM users WHERE id = ?', [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });

    const [orders] = await pool.query(
        'SELECT id, kode_pesanan, total_bayar, status_pesanan, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.params.id]
    );
    res.json({ success: true, data: {...rows[0], riwayat_pesanan: orders } });
}));

// PUT update data pengguna
app.put('/api/admin/users/:id', verifyAdmin, asyncHandler(async(req, res) => {
    const { nama_lengkap, email, role, status_akun } = req.body;
    if (!nama_lengkap || !email || !role || !status_akun) {
        return res.status(400).json({ success: false, message: 'Semua field wajib diisi.' });
    }

    try {
        const [result] = await pool.query(
            'UPDATE users SET nama_lengkap = ?, email = ?, role = ?, status_akun = ? WHERE id = ?', [nama_lengkap, email, role, status_akun, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
        res.json({ success: true, message: 'Data pengguna berhasil diperbarui.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Email sudah digunakan.' });
        throw err;
    }
}));

// PATCH toggle status blokir/aktif
app.patch('/api/admin/users/:id/status', verifyAdmin, asyncHandler(async(req, res) => {
    const { status_akun } = req.body;
    if (!['aktif', 'diblokir'].includes(status_akun)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }
    const [result] = await pool.query(
        'UPDATE users SET status_akun = ? WHERE id = ?', [status_akun, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    res.json({ success: true, message: `Pengguna berhasil ${status_akun === 'diblokir' ? 'diblokir' : 'diaktifkan'}.` });
}));

// DELETE hapus pengguna
app.delete('/api/admin/users/:id', verifyAdmin, asyncHandler(async(req, res) => {
    if (parseInt(req.params.id) === req.user.id) {
        return res.status(400).json({ success: false, message: 'Tidak bisa menghapus akun sendiri.' });
    }
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    res.json({ success: true, message: 'Pengguna berhasil dihapus.' });
}));

/* ==========================================================
 * 7. ROUTES — ADMIN PRODUCTS (admin-katalog.html & admin-edit-produk.html)
 * ========================================================== */

// GET semua produk (admin)
app.get('/api/admin/products', verifyAdmin, asyncHandler(async(req, res) => {
    const { kategori, status, search } = req.query;
    let query = `SELECT p.*, u.nama_lengkap AS nama_kreator
                 FROM products p LEFT JOIN users u ON p.creator_id = u.id WHERE 1=1`;
    const params = [];

    if (kategori) {
        query += ' AND p.kategori = ?';
        params.push(kategori);
    }
    if (status) {
        query += ' AND p.status_produk = ?';
        params.push(status);
    }
    if (search) {
        query += ' AND (p.nama_produk LIKE ? OR p.kode_produk LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY p.created_at DESC';
    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
}));

// GET detail satu produk
app.get('/api/admin/products/:id', verifyAdmin, asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        'SELECT p.*, u.nama_lengkap AS nama_kreator FROM products p LEFT JOIN users u ON p.creator_id = u.id WHERE p.id = ?', [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
    res.json({ success: true, data: rows[0] });
}));

// POST tambah produk baru
app.post('/api/admin/products', verifyAdmin, asyncHandler(async(req, res) => {
    const { kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, varian_label, varian_opsi, teks_kustom_max } = req.body;
    if (!nama_produk || !harga_jual) {
        return res.status(400).json({ success: false, message: 'Nama produk dan harga jual wajib diisi.' });
    }
    try {
        const [result] = await pool.query(
            `INSERT INTO products (creator_id, kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, varian_label, varian_opsi, teks_kustom_max)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.user.id, kode_produk || null, nama_produk, kategori || null, harga_asli || null,
                harga_jual, stok || 0, deskripsi || null, foto_url || null, status_produk || 'aktif',
                varian_label || null, varian_opsi || null, teks_kustom_max || 0
            ]
        );
        res.status(201).json({ success: true, message: 'Produk berhasil ditambahkan.', id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Kode produk sudah digunakan.' });
        throw err;
    }
}));

// PUT update produk
app.put('/api/admin/products/:id', verifyAdmin, asyncHandler(async(req, res) => {
    const { kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, varian_label, varian_opsi, teks_kustom_max } = req.body;
    if (!nama_produk || !harga_jual) {
        return res.status(400).json({ success: false, message: 'Nama produk dan harga jual wajib diisi.' });
    }
    try {
        const [result] = await pool.query(
            `UPDATE products SET kode_produk=?, nama_produk=?, kategori=?, harga_asli=?, harga_jual=?,
             stok=?, deskripsi=?, foto_url=?, status_produk=?, varian_label=?, varian_opsi=?, teks_kustom_max=? WHERE id=?`, [kode_produk || null, nama_produk, kategori || null, harga_asli || null, harga_jual,
                stok || 0, deskripsi || null, foto_url || null, status_produk || 'aktif',
                varian_label || null, varian_opsi || null, teks_kustom_max || 0, req.params.id
            ]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
        res.json({ success: true, message: 'Produk berhasil diperbarui.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Kode produk sudah digunakan.' });
        throw err;
    }
}));

// PATCH update status produk saja
app.patch('/api/admin/products/:id/status', verifyAdmin, asyncHandler(async(req, res) => {
    const { status_produk } = req.body;
    if (!['aktif', 'habis', 'nonaktif'].includes(status_produk)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }
    const [result] = await pool.query(
        'UPDATE products SET status_produk = ? WHERE id = ?', [status_produk, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
    res.json({ success: true, message: `Status produk diubah ke "${status_produk}".` });
}));

// DELETE hapus produk
app.delete('/api/admin/products/:id', verifyAdmin, asyncHandler(async(req, res) => {
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
    res.json({ success: true, message: 'Produk berhasil dihapus.' });
}));

/* ==========================================================
 * 8. ROUTES — ADMIN ORDERS (admin-pesanan.html & admin-detail-pesanan.html)
 * ========================================================== */

// GET semua pesanan (admin — lebih lengkap dari seller)
app.get('/api/admin/orders', verifyAdmin, asyncHandler(async(req, res) => {
    const { status, search } = req.query;
    let query = `SELECT o.id, o.kode_pesanan, o.nama_penerima, o.nomor_telepon,
                        o.metode_pembayaran, o.total_bayar, o.status_pesanan,
                        o.kurir, o.nomor_resi, o.created_at,
                        u.nama_lengkap AS nama_user, u.email AS email_user
                 FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE 1=1`;
    const params = [];

    if (status) {
        query += ' AND o.status_pesanan = ?';
        params.push(status);
    }
    if (search) {
        query += ' AND (o.kode_pesanan LIKE ? OR o.nama_penerima LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY o.created_at DESC';
    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
}));

// GET detail satu pesanan + item-itemnya
app.get('/api/admin/orders/:id', verifyAdmin, asyncHandler(async(req, res) => {
    const [orders] = await pool.query(
        `SELECT o.*, u.nama_lengkap AS nama_user, u.email AS email_user
         FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?`, [req.params.id]
    );
    if (orders.length === 0) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan.' });

    const [items] = await pool.query(
        `SELECT oi.id, oi.varian, oi.teks_kustom, oi.harga_satuan, oi.kuantitas,
                p.nama_produk, p.kode_produk, p.foto_url
         FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = ?`, [req.params.id]
    );
    res.json({ success: true, data: {...orders[0], items } });
}));

// PATCH update status pesanan (admin) + kurir + nomor resi
app.patch('/api/admin/orders/:id/status', verifyAdmin, asyncHandler(async(req, res) => {
    const { status_pesanan, kurir, nomor_resi } = req.body;
    const allowed = ['belum_bayar', 'diproses', 'dikirim', 'selesai', 'dibatalkan'];

    if (!allowed.includes(status_pesanan)) {
        return res.status(400).json({ success: false, message: `Status tidak valid. Pilihan: ${allowed.join(', ')}` });
    }
    if (status_pesanan === 'dikirim' && !kurir) {
        return res.status(400).json({ success: false, message: 'Nama kurir wajib diisi untuk status "dikirim".' });
    }

    const [result] = await pool.query(
        'UPDATE orders SET status_pesanan = ?, kurir = ?, nomor_resi = ? WHERE id = ?', [status_pesanan, kurir || null, nomor_resi || null, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan.' });
    res.json({ success: true, message: `Status pesanan diubah ke "${status_pesanan}".` });
}));

/* ==========================================================
 * 9. ROUTES — SELLER / KREATOR
 * ========================================================== */

const verifyKreator = (req, res, next) => {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Token tidak ditemukan.' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!['kreator', 'admin'].includes(decoded.role)) {
            return res.status(403).json({ success: false, message: 'Akses ditolak. Hanya kreator.' });
        }
        req.user = decoded;
        next();
    } catch {
        return res.status(403).json({ success: false, message: 'Token tidak valid.' });
    }
};

// POST /api/seller/upload-foto — terima FormData (field 'foto') ATAU base64 { data }
app.post('/api/seller/upload-foto', verifyKreator, terimaUpload('foto'), (req, res) => {
    const url = resolveUploadedFile(req);
    if (!url) return res.status(400).json({ success: false, message: 'File tidak ditemukan.' });
    res.json({ success: true, url });
});

// GET /api/seller/products — produk milik kreator ini saja
app.get('/api/seller/products', verifyKreator, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM products WHERE creator_id = ? ORDER BY created_at DESC',
        [req.user.id]
    );
    res.json({ success: true, data: rows });
}));

// POST /api/seller/products — tambah produk baru
app.post('/api/seller/products', verifyKreator, asyncHandler(async (req, res) => {
    const { kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, varian_label, varian_opsi, teks_kustom_max } = req.body;
    if (!nama_produk || !harga_jual)
        return res.status(400).json({ success: false, message: 'Nama produk dan harga jual wajib diisi.' });
    try {
        const [result] = await pool.query(
            `INSERT INTO products (creator_id, kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, varian_label, varian_opsi, teks_kustom_max)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, kode_produk || null, nama_produk, kategori || null, harga_asli || null,
             harga_jual, stok || 0, deskripsi || null, foto_url || null, status_produk || 'aktif',
             varian_label || null, varian_opsi || null, teks_kustom_max || 0]
        );
        res.status(201).json({ success: true, message: 'Produk berhasil ditambahkan.', id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Kode produk sudah digunakan.' });
        throw err;
    }
}));

// PUT /api/seller/products/:id — edit produk (hanya miliknya)
app.put('/api/seller/products/:id', verifyKreator, asyncHandler(async (req, res) => {
    const { kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, varian_label, varian_opsi, teks_kustom_max } = req.body;
    if (!nama_produk || !harga_jual)
        return res.status(400).json({ success: false, message: 'Nama produk dan harga jual wajib diisi.' });
    try {
        const [result] = await pool.query(
            `UPDATE products SET kode_produk=?, nama_produk=?, kategori=?, harga_asli=?, harga_jual=?,
             stok=?, deskripsi=?, foto_url=?, status_produk=?, varian_label=?, varian_opsi=?, teks_kustom_max=? WHERE id=? AND creator_id=?`,
            [kode_produk || null, nama_produk, kategori || null, harga_asli || null, harga_jual,
             stok || 0, deskripsi || null, foto_url || null, status_produk || 'aktif',
             varian_label || null, varian_opsi || null, teks_kustom_max || 0,
             req.params.id, req.user.id]
        );
        if (result.affectedRows === 0)
            return res.status(404).json({ success: false, message: 'Produk tidak ditemukan atau bukan milik kamu.' });
        res.json({ success: true, message: 'Produk berhasil diperbarui.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Kode produk sudah digunakan.' });
        throw err;
    }
}));

// DELETE /api/seller/products/:id — hapus produk (hanya miliknya)
app.delete('/api/seller/products/:id', verifyKreator, asyncHandler(async (req, res) => {
    const [result] = await pool.query(
        'DELETE FROM products WHERE id = ? AND creator_id = ?',
        [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0)
        return res.status(404).json({ success: false, message: 'Produk tidak ditemukan atau bukan milik kamu.' });
    res.json({ success: true, message: 'Produk berhasil dihapus.' });
}));

// GET /api/seller/orders — pesanan yang mengandung produk milik kreator ini
app.get('/api/seller/orders', verifyKreator, asyncHandler(async (req, res) => {
    const sellerId = Number(req.user.id);

    // Satu query: ambil semua order + item milik seller sekaligus
    const [rows] = await pool.query(
        `SELECT o.id AS order_id, o.kode_pesanan, o.nama_penerima, o.nomor_telepon,
                o.alamat_lengkap, o.status_pesanan, o.total_bayar, o.bukti_pembayaran,
                o.kurir, o.nomor_resi, o.metode_pembayaran, o.created_at,
                u.nama_lengkap AS nama_user,
                oi.kuantitas, oi.harga_satuan, oi.varian, oi.teks_kustom,
                p.nama_produk, p.foto_url, p.kategori
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN users u ON u.id = o.user_id
         WHERE p.creator_id = ?
         ORDER BY o.created_at DESC`,
        [sellerId]
    );

    if (!rows.length) return res.json({ success: true, data: [] });

    // Kelompokkan rows per order
    const ordersMap = {};
    rows.forEach(row => {
        if (!ordersMap[row.order_id]) {
            ordersMap[row.order_id] = {
                id: row.order_id,
                kode_pesanan: row.kode_pesanan,
                nama_penerima: row.nama_penerima,
                nomor_telepon: row.nomor_telepon,
                alamat_lengkap: row.alamat_lengkap,
                status_pesanan: row.status_pesanan,
                kurir: row.kurir,
                nomor_resi: row.nomor_resi,
                metode_pembayaran: row.metode_pembayaran,
                bukti_pembayaran: row.bukti_pembayaran,
                created_at: row.created_at,
                nama_user: row.nama_user,
                items: [],
                subtotal_seller: 0,
                total_bayar: row.total_bayar,
            };
        }
        ordersMap[row.order_id].items.push({
            nama_produk: row.nama_produk,
            kategori: row.kategori,
            foto_url: row.foto_url,
            kuantitas: row.kuantitas,
            harga_satuan: row.harga_satuan,
            varian: row.varian,
            teks_kustom: row.teks_kustom,
        });
        ordersMap[row.order_id].subtotal_seller += row.harga_satuan * row.kuantitas;
    });

    res.json({ success: true, data: Object.values(ordersMap) });
}));

// PATCH /api/seller/orders/:id/status — update status pesanan (hanya milik seller)
app.patch('/api/seller/orders/:id/status', verifyKreator, asyncHandler(async (req, res) => {
    const { status_pesanan, kurir, nomor_resi } = req.body;
    const allowed = ['diproses', 'dikirim', 'selesai', 'dibatalkan'];
    if (!allowed.includes(status_pesanan))
        return res.status(400).json({ success: false, message: `Status tidak valid. Pilihan: ${allowed.join(', ')}` });
    if (status_pesanan === 'dikirim' && !kurir)
        return res.status(400).json({ success: false, message: 'Nama kurir wajib diisi untuk status dikirim.' });

    // Pastikan pesanan ini mengandung produk milik seller ini
    const [check] = await pool.query(
        `SELECT o.id FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         WHERE o.id = ? AND p.creator_id = ? LIMIT 1`,
        [req.params.id, req.user.id]
    );
    if (check.length === 0)
        return res.status(403).json({ success: false, message: 'Pesanan tidak ditemukan atau bukan milikmu.' });

    await pool.query(
        'UPDATE orders SET status_pesanan=?, kurir=?, nomor_resi=? WHERE id=?',
        [status_pesanan, kurir || null, nomor_resi || null, req.params.id]
    );
    res.json({ success: true, message: `Status berhasil diubah ke "${status_pesanan}".` });
}));

// GET /api/user/:userId/ai-requests — riwayat custom AI milik customer untuk order-history.html
app.get('/api/user/:userId/ai-requests', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT a.id, a.prompt_text, a.visual_style, a.material, a.image_url,
                a.status_approval, a.created_at,
                u.nama_lengkap AS nama_kreator
         FROM ai_custom_designs a
         LEFT JOIN users u ON u.id = a.creator_id
         WHERE a.user_id = ?
           AND a.prompt_text NOT LIKE '[DESIGN SUBMISSION]%'
         ORDER BY a.created_at DESC`,
        [req.params.userId]
    );
    res.json({ success: true, data: rows });
}));

// GET /api/seller/ai-requests — hanya request yang ditujukan ke seller ini
app.get('/api/seller/ai-requests', verifyKreator, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT a.id, a.prompt_text, a.visual_style, a.material, a.image_url,
                a.status_approval, a.created_at,
                u.nama_lengkap AS nama_user, u.email AS email_user
         FROM ai_custom_designs a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.creator_id = ?
           AND a.prompt_text NOT LIKE '[DESIGN SUBMISSION]%'
         ORDER BY a.created_at DESC`,
        [req.user.id]
    );
    res.json({ success: true, data: rows });
}));

// PATCH /api/seller/ai-requests/:id/status — validasi desain oleh seller
app.patch('/api/seller/ai-requests/:id/status', verifyKreator, asyncHandler(async (req, res) => {
    const { status_approval } = req.body;
    // Frontend mengirim 'siap_produksi' atau 'ditolak'
    if (!['siap_produksi', 'ditolak'].includes(status_approval))
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });

    const [check] = await pool.query(
        'SELECT id FROM ai_custom_designs WHERE id = ? AND creator_id = ?',
        [req.params.id, req.user.id]
    );
    if (check.length === 0)
        return res.status(403).json({ success: false, message: 'Request tidak ditemukan.' });

    // Map 'siap_produksi' → 'disetujui' di DB (enum yang ada)
    const dbStatus = status_approval === 'siap_produksi' ? 'disetujui' : 'ditolak';
    await pool.query('UPDATE ai_custom_designs SET status_approval = ? WHERE id = ?',
        [dbStatus, req.params.id]);
    res.json({ success: true, message: status_approval === 'siap_produksi' ? 'Desain divalidasi, status Siap Produksi.' : 'Desain ditolak.' });
}));

// GET /api/seller/stats — statistik milik kreator ini
app.get('/api/seller/stats', verifyKreator, asyncHandler(async (req, res) => {
    const [[{ totalProduk }]] = await pool.query(
        'SELECT COUNT(*) AS totalProduk FROM products WHERE creator_id = ?', [req.user.id]
    );
    const [[{ totalPesanan }]] = await pool.query(
        `SELECT COUNT(DISTINCT o.id) AS totalPesanan FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id WHERE p.creator_id = ?`, [req.user.id]
    );
    // Pendapatan: semua order yang sudah dibayar (bukan belum_bayar / dibatalkan)
    const [[{ pendapatan }]] = await pool.query(
        `SELECT COALESCE(SUM(oi.harga_satuan * oi.kuantitas), 0) AS pendapatan
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         JOIN orders o ON o.id = oi.order_id
         WHERE p.creator_id = ?
           AND o.status_pesanan NOT IN ('belum_bayar','dibatalkan')`, [req.user.id]
    );
    // Pesanan yang perlu diproses (sudah dibayar, belum dikirim)
    const [[{ perluDiproses }]] = await pool.query(
        `SELECT COUNT(DISTINCT o.id) AS perluDiproses FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         WHERE p.creator_id = ? AND o.status_pesanan = 'diproses'`, [req.user.id]
    );
    res.json({ success: true, data: { totalProduk, totalPesanan, pendapatan, perluDiproses } });
}));

// GET /api/seller/chart — data grafik penjualan 7 hari terakhir milik kreator ini
app.get('/api/seller/chart', verifyKreator, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT
            DATE_FORMAT(o.created_at, '%a') AS label,
            DATE(o.created_at) AS tgl,
            COUNT(DISTINCT o.id) AS total_pesanan,
            COALESCE(SUM(oi.harga_satuan * oi.kuantitas), 0) AS total_revenue
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         WHERE p.creator_id = ?
           AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
           AND o.status_pesanan IN ('diproses','dikirim','selesai')
         GROUP BY DATE(o.created_at), DATE_FORMAT(o.created_at, '%a')
         ORDER BY tgl ASC`,
        [req.user.id]
    );

    // Isi hari-hari yang kosong dengan 0 (7 hari penuh)
    const dayMap = {};
    rows.forEach(r => { dayMap[r.tgl] = r; });

    const result = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
        result.push({
            label: dayNames[d.getDay()],
            total_pesanan: dayMap[key] ? Number(dayMap[key].total_pesanan) : 0,
            total_revenue: dayMap[key] ? Number(dayMap[key].total_revenue) : 0,
        });
    }
    res.json({ success: true, data: result });
}));

/* ==========================================================
 * 10. ROUTES — CONSUMER (endpoint sesuai file teman)
 * ========================================================== */

/**
 * POST /api/login  — alias untuk consumer/login.html
 * Response format: { pesan, user }
 */
app.post('/api/login', asyncHandler(async(req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ pesan: 'Email dan password wajib diisi.' });

    const [rows] = await pool.query(
        'SELECT id, nama_lengkap, email, role, status_akun FROM users WHERE email = ? AND password = ?', [email.trim(), password]
    );
    if (rows.length === 0)
        return res.status(401).json({ pesan: 'Email atau password salah.' });

    const user = rows[0];
    if (user.status_akun === 'diblokir')
        return res.status(403).json({ pesan: 'Akun kamu diblokir.' });

    res.json({ pesan: 'Login berhasil!', user });
}));

/**
 * POST /api/register  — alias untuk consumer/register.html
 * Body: { nama, email, password }
 * Response: { pesan }
 */
app.post('/api/register', asyncHandler(async(req, res) => {
    const { nama, email, password } = req.body;
    if (!nama || !email || !password)
        return res.status(400).json({ pesan: 'Semua field wajib diisi.' });
    if (password.length < 6)
        return res.status(400).json({ pesan: 'Password minimal 6 karakter.' });

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email.trim()]);
    if (existing.length > 0)
        return res.status(409).json({ pesan: 'Email sudah terdaftar. Silakan login.' });

    await pool.query(
        'INSERT INTO users (nama_lengkap, email, password, role, status_akun) VALUES (?, ?, ?, ?, ?)', [nama.trim(), email.trim(), password, 'pelanggan', 'aktif']
    );
    res.status(201).json({ pesan: 'Akun berhasil dibuat! Silakan login.' });
}));

/**
 * GET /api/products/:id  — detail produk untuk product-detail.html
 */
app.get('/api/products/:id', asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM products WHERE id = ?', [req.params.id]
    );
    if (rows.length === 0)
        return res.status(404).json({ pesan: 'Produk tidak ditemukan.' });

    // Statistik penjualan & rating (fitur review)
    const [[{ total_terjual }]] = await pool.query(
        `SELECT COALESCE(SUM(oi.kuantitas), 0) AS total_terjual
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.product_id = ? AND o.status_pesanan != 'dibatalkan'`, [req.params.id]
    );
    const [[{ rata_rating, jumlah_review }]] = await pool.query(
        `SELECT COALESCE(ROUND(AVG(rating), 1), 0) AS rata_rating, COUNT(*) AS jumlah_review
         FROM reviews WHERE product_id = ?`, [req.params.id]
    );

    const product = rows[0];
    product.total_terjual = Number(total_terjual);
    product.rata_rating = Number(rata_rating);
    product.jumlah_review = Number(jumlah_review);
    res.json(product);
}));

/**
 * POST /api/reviews  — tambah ulasan produk (satu review per produk per pesanan)
 */
app.post('/api/reviews', asyncHandler(async(req, res) => {
    const { user_id, product_id, order_id, rating, komentar } = req.body;
    if (!user_id || !product_id || !order_id || !rating) {
        return res.status(400).json({ success: false, message: 'Data tidak lengkap.' });
    }

    const [existing] = await pool.query(
        `SELECT id FROM reviews WHERE user_id = ? AND product_id = ? AND order_id = ?`,
        [user_id, product_id, order_id]
    );
    if (existing.length > 0) {
        return res.status(400).json({ success: false, message: 'Anda sudah memberikan ulasan untuk produk ini pada pesanan ini.' });
    }

    await pool.query(
        `INSERT INTO reviews (user_id, product_id, order_id, rating, komentar) VALUES (?, ?, ?, ?, ?)`,
        [user_id, product_id, order_id, rating, komentar || null]
    );

    res.json({ success: true, message: 'Ulasan berhasil dikirim!' });
}));

/**
 * GET /api/user/profile/:id  — detail profil user
 */
app.get('/api/user/profile/:id', asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        'SELECT id, nama_lengkap, email, role, status_akun, created_at FROM users WHERE id = ?', [req.params.id]
    );
    if (rows.length === 0)
        return res.status(404).json({ pesan: 'Pengguna tidak ditemukan.' });

    res.json({ success: true, user: rows[0] });
}));

/**
 * PUT /api/user/profile/:id  — update detail profil user
 */
app.put('/api/user/profile/:id', asyncHandler(async(req, res) => {
    const { nama_lengkap, email, password } = req.body;

    if (!nama_lengkap || !email) {
        return res.status(400).json({ success: false, pesan: 'Nama lengkap dan email wajib diisi.' });
    }

    // Cek duplikasi email
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim(), req.params.id]);
    if (existing.length > 0) {
        return res.status(409).json({ success: false, pesan: 'Email sudah terdaftar oleh pengguna lain.' });
    }

    if (password && password.length > 0) {
        if (password.length < 6) {
            return res.status(400).json({ success: false, pesan: 'Password minimal 6 karakter.' });
        }
        await pool.query(
            'UPDATE users SET nama_lengkap = ?, email = ?, password = ? WHERE id = ?',
            [nama_lengkap.trim(), email.trim(), password, req.params.id]
        );
    } else {
        await pool.query(
            'UPDATE users SET nama_lengkap = ?, email = ? WHERE id = ?',
            [nama_lengkap.trim(), email.trim(), req.params.id]
        );
    }

    res.json({ success: true, pesan: 'Profil berhasil diperbarui!' });
}));

/**
 * GET /api/orders/:userId  — riwayat pesanan user untuk order-history.html
 */
app.get('/api/orders/:userId', asyncHandler(async(req, res) => {
    const userId = req.params.userId;
    if (isNaN(userId)) return res.status(400).json({ pesan: 'User ID tidak valid.' });

    const [orders] = await pool.query(
        `SELECT o.* FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC`, [userId]
    );

    if (orders.length === 0) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const [items] = await pool.query(
        `SELECT oi.order_id, oi.product_id, oi.harga_satuan, oi.kuantitas, oi.varian, oi.teks_kustom,
                p.nama_produk, p.kategori, p.foto_url,
                p.creator_id, u.nama_lengkap AS nama_kreator,
                r.rating AS review_rating, r.komentar AS review_komentar
         FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         LEFT JOIN users u ON u.id = p.creator_id
         LEFT JOIN reviews r ON r.order_id = oi.order_id AND r.product_id = oi.product_id
         WHERE oi.order_id IN (?)`, [orderIds]
    );

    const itemsByOrder = {};
    items.forEach(item => {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
    });

    const result = orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
    res.json(result);
}));

/**
 * GET /api/orders/detail/:orderId  — detail invoice untuk invoice.html
 */
app.get('/api/orders/detail/:orderId', asyncHandler(async(req, res) => {
    const [orders] = await pool.query(
        'SELECT * FROM orders WHERE id = ?', [req.params.orderId]
    );
    if (orders.length === 0)
        return res.status(404).json({ pesan: 'Pesanan tidak ditemukan.' });

    const order = orders[0];
    const [items] = await pool.query(
        `SELECT oi.*, p.nama_produk, p.foto_url
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ?`, [order.id]
    );
    order.items = items;
    res.json(order);
}));

/**
 * PUT /api/orders/:orderId/pay  — simulasi bayar untuk invoice.html
 */
app.put('/api/orders/:orderId/pay', asyncHandler(async(req, res) => {
    const { bukti_pembayaran } = req.body || {};
    const [result] = await pool.query(
        `UPDATE orders SET status_pesanan = 'diproses', bukti_pembayaran = ? WHERE id = ? AND status_pesanan = 'belum_bayar'`,
        [bukti_pembayaran || null, req.params.orderId]
    );
    if (result.affectedRows === 0)
        return res.status(400).json({ pesan: 'Pesanan tidak ditemukan atau sudah dibayar.' });

    res.json({ pesan: 'Pembayaran berhasil! Pesananmu sedang diproses.' });
}));

/**
 * GET /api/orders/group/:groupCode  — ambil semua order dalam 1 payment_group (multi-invoice)
 */
app.get('/api/orders/group/:groupCode', asyncHandler(async(req, res) => {
    const { groupCode } = req.params;
    const [orders] = await pool.query(
        `SELECT id, kode_pesanan, nama_penerima, nomor_telepon, alamat_lengkap,
                jenis_pengiriman, metode_pembayaran, subtotal_produk, ongkos_kirim,
                biaya_layanan, total_bayar, status_pesanan, payment_group, created_at
         FROM orders WHERE payment_group = ? ORDER BY id ASC`, [groupCode]
    );
    if (orders.length === 0)
        return res.status(404).json({ pesan: 'Payment group tidak ditemukan.' });

    const orderIds = orders.map(o => o.id);
    const [items] = await pool.query(
        `SELECT oi.order_id, oi.harga_satuan, oi.kuantitas, oi.varian, oi.teks_kustom,
                p.nama_produk, p.foto_url, p.kategori,
                p.creator_id, u.nama_lengkap AS nama_kreator
         FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         LEFT JOIN users u ON u.id = p.creator_id
         WHERE oi.order_id IN (?)`, [orderIds]
    );

    const itemsByOrder = {};
    items.forEach(item => {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
    });

    const result = orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
    res.json({ success: true, data: result });
}));

/**
 * PUT /api/orders/group/:groupCode/pay  — bayar semua order dalam 1 payment_group sekaligus
 */
app.put('/api/orders/group/:groupCode/pay', asyncHandler(async(req, res) => {
    const { bukti_pembayaran } = req.body || {};
    const [result] = await pool.query(
        `UPDATE orders SET status_pesanan = 'diproses', bukti_pembayaran = ? WHERE payment_group = ? AND status_pesanan = 'belum_bayar'`,
        [bukti_pembayaran || null, req.params.groupCode]
    );
    if (result.affectedRows === 0)
        return res.status(400).json({ pesan: 'Semua pesanan sudah dibayar atau tidak ditemukan.' });

    res.json({ pesan: `Pembayaran berhasil! ${result.affectedRows} pesanan sedang diproses.` });
}));

/**
 * POST /api/orders  — buat pesanan baru dari checkout.html
 * Body: { pic_id, total_tagihan, metode_pembayaran, metode_pengiriman, order_items[] }
 */
app.post('/api/orders', asyncHandler(async(req, res) => {
    const { pic_id, metode_pembayaran, metode_pengiriman, order_items } = req.body;
    if (!pic_id || !order_items || order_items.length === 0) {
        return res.status(400).json({ pesan: 'Data pesanan tidak lengkap.' });
    }

    // Gunakan koneksi database khusus untuk Transaction
    const conn = await pool.getConnection();

    try {
        // Mulai transaksi database (jika 1 proses gagal, semuanya otomatis dibatalkan)
        await conn.beginTransaction();

        // Ambil alamat utama user
        const [addresses] = await conn.query(
            'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_utama DESC LIMIT 1', [pic_id]
        );
        const addr = addresses[0] || {};
        const namaAlamat = addr.nama_penerima || 'Belum ada alamat';
        const telpAlamat = addr.nomor_telepon || '-';
        const detailAlamat = addr.detail_alamat ? `${addr.detail_alamat}, ${addr.wilayah}` : 'Belum ada alamat';

        // Ongkir per seller
        const ongkirPerOrder = metode_pengiriman === 'Next Day' ? 35000 : metode_pengiriman === 'Kargo' ? 25000 : 15000;
        const layanan = 1000;

        // Group items by creator_id
        const sellerMap = {};
        for (const item of order_items) {
            const key = item.creator_id || 'unknown';
            if (!sellerMap[key]) sellerMap[key] = { nama_kreator: item.nama_kreator || 'Uni Gift Studio', items: [] };
            sellerMap[key].items.push(item);
        }
        const sellerGroups = Object.values(sellerMap);

        // Shared payment_group untuk semua order dalam 1 checkout
        const paymentGroup = 'PG-' + Math.floor(Math.random() * 90000 + 10000);

        const createdOrders = [];
        for (const group of sellerGroups) {
            const subtotal = group.items.reduce((s, i) => s + ((i.price || i.harga || 0) * (i.quantity || i.kuantitas || 1)), 0);
            const total = subtotal + ongkirPerOrder + layanan;
            const kode = 'UGS-' + Math.floor(Math.random() * 90000 + 10000);

            const [orderResult] = await conn.query(
                `INSERT INTO orders
                 (user_id, kode_pesanan, nama_penerima, nomor_telepon, alamat_lengkap,
                  jenis_pengiriman, metode_pembayaran, subtotal_produk, ongkos_kirim,
                  biaya_layanan, total_bayar, status_pesanan, payment_group)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'belum_bayar', ?)`,
                [pic_id, kode, namaAlamat, telpAlamat, detailAlamat,
                 metode_pengiriman, metode_pembayaran, subtotal, ongkirPerOrder, layanan, total, paymentGroup]
            );

            const orderId = orderResult.insertId;
            for (const item of group.items) {
                const productId = item.id || item.product_id || null;
                const harga = item.price || item.harga || 0;
                const qty = item.quantity || item.kuantitas || 1;

                await conn.query(
                    'INSERT INTO order_items (order_id, product_id, harga_satuan, kuantitas, varian, teks_kustom) VALUES (?, ?, ?, ?, ?, ?)',
                    [orderId, productId, harga, qty, item.varian || null, item.teks_kustom || null]
                );
            }
            createdOrders.push({ order_id: orderId, kode_pesanan: kode, nama_kreator: group.nama_kreator, subtotal, total });
        }

        // Hapus data keranjang user dari DB setelah order sukses dibuat
        await conn.query('DELETE FROM carts WHERE user_id = ?', [pic_id]);

        // Simpan semua perubahan ke database secara permanen
        await conn.commit();
        conn.release();

        // Untuk backward-compat (custom-ai.html yang masih pakai single order): kembalikan order pertama juga
        res.status(201).json({
            pesan: 'Pesanan berhasil dibuat!',
            payment_group: paymentGroup,
            orders: createdOrders,
            order_id: createdOrders[0]?.order_id,
            kode_pesanan: createdOrders[0]?.kode_pesanan
        });

    } catch (error) {
        // Batalkan semua insert jika ada salah satu yang gagal
        await conn.rollback();
        conn.release();
        throw error; // Lempar error ke handler global agar terbaca di console
    }
}));

/**
 * GET /api/addresses/:userId  — daftar alamat tersimpan milik user untuk checkout.html
 */
app.get('/api/addresses/:userId', asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_utama DESC, id DESC', [req.params.userId]
    );
    res.json({ success: true, data: rows });
}));

/**
 * POST /api/addresses  — simpan alamat baru untuk tambah_alamat.html
 * Body: { pic_id, nama_penerima, nomor_telepon, label_alamat, wilayah, detail_alamat, latitude, longitude, is_utama }
 */
app.post('/api/addresses', asyncHandler(async(req, res) => {
    const { pic_id, nama_penerima, nomor_telepon, label_alamat, wilayah, detail_alamat, latitude, longitude, is_utama } = req.body;
    if (!pic_id || !nama_penerima || !detail_alamat)
        return res.status(400).json({ pesan: 'Data alamat tidak lengkap.' });

    // Kalau is_utama = 1, reset semua alamat lain dulu
    if (is_utama) {
        await pool.query('UPDATE user_addresses SET is_utama = 0 WHERE user_id = ?', [pic_id]);
    }

    const [result] = await pool.query(
        `INSERT INTO user_addresses
         (user_id, nama_penerima, nomor_telepon, label_alamat, wilayah, detail_alamat, latitude, longitude, is_utama)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [pic_id, nama_penerima, nomor_telepon || '-', label_alamat || 'Rumah',
            wilayah || '-', detail_alamat, latitude || null, longitude || null, is_utama ? 1 : 0
        ]
    );

    res.status(201).json({ pesan: 'Alamat berhasil disimpan!', insertId: result.insertId });
}));

/**
 * POST /api/cart  — simpan/update item keranjang
 * (Disimpan di DB, tapi consumer juga pakai localStorage sebagai cache)
 */
app.post('/api/cart', asyncHandler(async(req, res) => {
    // Support dua format:
    // Format cart.html: { pic_id, cart_items: [{id, price, quantity, ...}] }
    // Format lama: { user_id, product_id, kuantitas }
    const userId = req.body.pic_id || req.body.user_id;
    const cartItems = req.body.cart_items;

    if (!userId) return res.status(400).json({ pesan: 'User ID tidak ditemukan.' });

    if (cartItems && Array.isArray(cartItems)) {
        // Sync seluruh keranjang: hapus lama, insert baru
        await pool.query('DELETE FROM carts WHERE user_id = ?', [userId]);
        for (const item of cartItems) {
            const productId = item.id || item.product_id;
            const qty = item.quantity || item.kuantitas || 1;
            const varian = item.varian || null;
            if (productId) {
                await pool.query(
                    'INSERT INTO carts (user_id, product_id, kuantitas, varian) VALUES (?, ?, ?, ?)', [userId, productId, qty, varian]
                );
            }
        }
        return res.status(201).json({ pesan: 'Keranjang berhasil disinkronisasi!' });
    }

    // Format lama — satu item (varian berbeda dihitung sebagai baris terpisah)
    const { product_id, kuantitas, varian } = req.body;
    if (!product_id) return res.status(400).json({ pesan: 'Data keranjang tidak lengkap.' });
    const [existing] = await pool.query(
        'SELECT id, kuantitas FROM carts WHERE user_id = ? AND product_id = ? AND (varian = ? OR (varian IS NULL AND ? IS NULL))',
        [userId, product_id, varian || null, varian || null]
    );
    if (existing.length > 0) {
        await pool.query('UPDATE carts SET kuantitas = ? WHERE id = ?', [existing[0].kuantitas + (kuantitas || 1), existing[0].id]);
    } else {
        await pool.query('INSERT INTO carts (user_id, product_id, kuantitas, varian) VALUES (?, ?, ?, ?)', [userId, product_id, kuantitas || 1, varian || null]);
    }
    res.status(201).json({ pesan: 'Produk ditambahkan ke keranjang!' });
}));

app.get('/api/orders', asyncHandler(async(req, res) => {
    const [rows] = await pool.query(`
        SELECT o.id, o.kode_pesanan, o.user_id, o.nama_penerima, o.nomor_telepon,
               o.alamat_lengkap, o.latitude, o.longitude, o.pesan_pembeli,
               o.metode_pembayaran, o.subtotal_produk, o.diskon, o.ongkos_kirim,
               o.biaya_layanan, o.total_bayar, o.status_pesanan, o.kurir, o.nomor_resi, o.created_at,
               u.nama_lengkap AS customer_name, u.email AS customer_email
        FROM orders o LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.created_at DESC
    `);
    res.json({ success: true, count: rows.length, data: rows });
}));

app.get('/api/user/:userId/addresses', asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_utama DESC', [req.params.userId]
    );
    res.json({ success: true, data: rows });
}));

app.patch('/api/orders/:id/status', asyncHandler(async(req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['belum_bayar', 'diproses', 'dikirim', 'selesai', 'dibatalkan'];

    if (!status || !allowed.includes(status)) {
        return res.status(400).json({ success: false, message: `Status tidak valid. Pilihan: ${allowed.join(', ')}` });
    }
    const [result] = await pool.query('UPDATE orders SET status_pesanan = ? WHERE id = ?', [status, id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    res.json({ success: true, message: 'Status pesanan berhasil diupdate', orderId: Number(id), status_pesanan: status });
}));

app.get('/api/stats', asyncHandler(async(req, res) => {
    const [
        [revenue]
    ] = await pool.query("SELECT COALESCE(SUM(total_bayar),0) AS total_revenue FROM orders WHERE status_pesanan != 'dibatalkan'");
    const [
        [orderCount]
    ] = await pool.query('SELECT COUNT(*) AS total_orders FROM orders');
    const [
        [aiCount]
    ] = await pool.query('SELECT COUNT(*) AS total_ai_requests FROM ai_custom_designs');

    res.json({
        success: true,
        data: {
            total_revenue: Number(revenue.total_revenue),
            total_orders: orderCount.total_orders,
            total_ai_requests: aiCount.total_ai_requests,
        }
    });
}));

app.get('/api/products', asyncHandler(async(req, res) => {
    const { status, kategori } = req.query;
    const where = [],
        params = [];

    if (status) {
        where.push('status_produk = ?');
        params.push(status);
    }
    if (kategori) {
        where.push('kategori = ?');
        params.push(kategori);
    }

    const sql = `SELECT p.id, p.kode_produk, p.creator_id, p.nama_produk, p.kategori,
                        p.harga_asli, p.harga_jual, p.stok, p.deskripsi, p.foto_url, p.status_produk, p.created_at,
                        p.varian_label, p.varian_opsi, p.teks_kustom_max,
                        u.nama_lengkap AS nama_kreator,
                        COALESCE((
                            SELECT SUM(oi.kuantitas)
                            FROM order_items oi
                            JOIN orders o ON o.id = oi.order_id
                            WHERE oi.product_id = p.id AND o.status_pesanan != 'dibatalkan'
                        ), 0) AS total_terjual,
                        COALESCE((
                            SELECT ROUND(AVG(rating), 1)
                            FROM reviews
                            WHERE product_id = p.id
                        ), 0) AS rata_rating
                 FROM products p
                 LEFT JOIN users u ON u.id = p.creator_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY p.created_at DESC`;
    const [rows] = await pool.query(sql, params);
    res.json({ success: true, count: rows.length, data: rows });
}));

/* ==========================================================
 * 10. ROUTES — KONTRIBUTOR
 * ========================================================== */

/**
 * POST /api/contributor-apply  (public)
 * Body: { nama_organisasi, tipe_organisasi, nama_pic, email, nomor_wa, tier, pesan }
 *
 * Tabel SQL yang dibutuhkan:
 *   CREATE TABLE contributors (
 *     id               INT PRIMARY KEY AUTO_INCREMENT,
 *     nama_organisasi  VARCHAR(255) NOT NULL,
 *     tipe_organisasi  VARCHAR(50),
 *     nama_pic         VARCHAR(255),
 *     email            VARCHAR(255),
 *     nomor_wa         VARCHAR(20),
 *     tier             ENUM('Bronze','Silver','Gold') DEFAULT 'Silver',
 *     pesan            TEXT,
 *     status           ENUM('pending','approved','rejected') DEFAULT 'pending',
 *     catatan_admin    TEXT,
 *     created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *     updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
 *   );
 */
app.post('/api/contributor-apply', asyncHandler(async(req, res) => {
    const { nama_organisasi, tipe_organisasi, nama_pic, email, nomor_wa, tier, pesan } = req.body;

    if (!nama_organisasi || !email) {
        return res.status(400).json({ success: false, message: 'Nama organisasi dan email wajib diisi.' });
    }

    const [result] = await pool.query(
        `INSERT INTO contributors (nama_organisasi, tipe_organisasi, nama_pic, email, nomor_wa, tier, pesan)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            nama_organisasi.trim(),
            tipe_organisasi || null,
            nama_pic || null,
            email.trim(),
            nomor_wa || null, ['Bronze', 'Silver', 'Gold'].includes(tier) ? tier : 'Silver',
            pesan || null,
        ]
    );

    res.status(201).json({
        success: true,
        message: 'Pendaftaran kontributor berhasil dikirim! Tim kami akan menghubungi kamu dalam 2–3 hari kerja.',
        id: result.insertId,
    });
}));

// GET semua pendaftar kontributor (admin)
app.get('/api/admin/contributors', verifyAdmin, asyncHandler(async(req, res) => {
    const { status, search } = req.query;
    let query = 'SELECT * FROM contributors WHERE 1=1';
    const params = [];

    if (status) { query += ' AND status = ?';
        params.push(status); }
    if (search) { query += ' AND (nama_organisasi LIKE ? OR email LIKE ? OR nama_pic LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
}));

// PATCH approve / reject kontributor (admin)
app.patch('/api/admin/contributors/:id/status', verifyAdmin, asyncHandler(async(req, res) => {
    const { status, catatan_admin, tier } = req.body;

    // Terima English (approved/rejected) maupun Indonesian (disetujui/ditolak)
    const statusMap = { approved: 'disetujui', rejected: 'ditolak', pending: 'pending' };
    const dbStatus = statusMap[status] || status;

    if (!['pending', 'disetujui', 'ditolak'].includes(dbStatus)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }

    const [result] = await pool.query(
        'UPDATE contributors SET status = ?, catatan_admin = ?, tier = COALESCE(?, tier) WHERE id = ?',
        [dbStatus, catatan_admin || null, tier || null, req.params.id]
    );

    if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Pendaftar tidak ditemukan.' });
    }

    res.json({ success: true, message: `Kontributor berhasil ${dbStatus === 'disetujui' ? 'disetujui' : dbStatus === 'ditolak' ? 'ditolak' : 'diperbarui'}.` });
}));

/**
 * GET /api/admin/ai-requests  (admin)
 * Semua request AI design dari pengguna
 */
app.get('/api/admin/ai-requests', verifyAdmin, asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        `SELECT a.id, a.prompt_text, a.visual_style, a.kualitas, a.material,
                a.status_approval, a.image_url, a.created_at,
                u.nama_lengkap AS nama_user, u.email AS email_user
         FROM ai_custom_designs a
         LEFT JOIN users u ON a.user_id = u.id
         WHERE a.prompt_text NOT LIKE '[DESIGN SUBMISSION]%'
         ORDER BY a.created_at DESC`
    );
    res.json({ success: true, data: rows });
}));

/**
 * PATCH /api/admin/ai-requests/:id/status  (admin)
 * Update status approval: pending | disetujui | ditolak
 */
app.patch('/api/admin/ai-requests/:id/status', verifyAdmin, asyncHandler(async(req, res) => {
    const { status } = req.body;
    if (!['pending', 'disetujui', 'ditolak'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }
    await pool.query('UPDATE ai_custom_designs SET status_approval = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: 'Status berhasil diperbarui.' });
}));

/**
 * GET /api/ai-generate?prompt=...
 * Generate gambar via HuggingFace Inference API (FLUX.1-schnell)
 */
app.get('/api/ai-generate', asyncHandler(async(req, res) => {
    const { prompt } = req.query;
    if (!prompt) return res.status(400).json({ error: 'prompt wajib diisi' });

    const HF_TOKEN = process.env.HF_TOKEN;
    if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN belum dikonfigurasi di .env' });

    const fullPrompt = `${prompt}, 3D souvenir product, high quality, white background, photorealistic`;

    try {
        const response = await fetch(
            'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${HF_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ inputs: fullPrompt }),
                signal: AbortSignal.timeout(120000) // 2 menit
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            return res.status(502).json({ error: 'AI sedang sibuk, coba lagi.', detail: errText });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(buffer);
    } catch (err) {
        res.status(503).json({ error: 'AI sedang sibuk, coba lagi.', detail: err.message });
    }
}));

// Terima FormData (field 'file') ATAU base64 { data } — kompatibel semua versi frontend
app.post('/api/upload', terimaUpload('file'), (req, res) => {
    const fileUrl = resolveUploadedFile(req);
    if (!fileUrl) {
        return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah.' });
    }
    res.json({ success: true, fileUrl });
});

// GET /api/sellers — daftar kreator aktif untuk dipilih consumer
app.get('/api/sellers', async(req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, nama_lengkap, email FROM users WHERE role = 'kreator' ORDER BY nama_lengkap ASC`
        );
        res.json({ success: true, data: rows });
    } catch(e) {
        console.error('[/api/sellers ERROR]', e.code, e.message, e);
        res.status(500).json({ success: false, message: e.message || e.code || 'DB error', data: [] });
    }
});

app.post('/api/ai-request', asyncHandler(async(req, res) => {
    const { user_id, creator_id, prompt_text, visual_style, kualitas, material, image_url } = req.body;
    if (!prompt_text || prompt_text.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'prompt_text wajib diisi' });
    }
    const [result] = await pool.query(
        `INSERT INTO ai_custom_designs (user_id, creator_id, prompt_text, visual_style, kualitas, material, image_url, status_approval)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`, [user_id || null, creator_id || null, prompt_text.trim(), visual_style || null, kualitas || null, material || null, image_url || null]
    );
    res.status(201).json({ success: true, message: 'Permintaan desain AI berhasil disimpan', id: result.insertId });
}));

/**
 * POST /api/design-submissions  (public)
 * Body: { nama, kategori, deskripsi, harga_saran, kontak, image_url }
 * Simpan kiriman desain dari Tab 2 "Upload & Earn"
 */
app.post('/api/design-submissions', asyncHandler(async(req, res) => {
    const { nama, kategori, deskripsi, harga_saran, kontak, image_url } = req.body;
    if (!nama || !nama.trim()) {
        return res.status(400).json({ success: false, message: 'Nama desain wajib diisi.' });
    }
    if (!kategori) {
        return res.status(400).json({ success: false, message: 'Kategori wajib dipilih.' });
    }
    if (!kontak || !kontak.trim()) {
        return res.status(400).json({ success: false, message: 'Email / WhatsApp kontak wajib diisi.' });
    }
    const promptText = `[DESIGN SUBMISSION] Nama: ${nama.trim()} | Deskripsi: ${deskripsi || '-'} | Harga Saran: ${harga_saran || '-'} | Kontak: ${kontak.trim()}`;
    const [result] = await pool.query(
        `INSERT INTO ai_custom_designs (prompt_text, visual_style, material, image_url, status_approval)
         VALUES (?, ?, ?, ?, 'pending')`, [promptText, kategori, kontak.trim(), image_url || null]
    );
    res.status(201).json({
        success: true,
        message: 'Desain berhasil dikirim! Tim kami akan menghubungi kamu dalam 1–3 hari kerja.',
        id: result.insertId
    });
}));

/**
 * GET /api/admin/design-submissions (admin)
 * Ambil semua submission desain dari creator
 */
app.get('/api/admin/design-submissions', verifyAdmin, asyncHandler(async(req, res) => {
    const [rows] = await pool.query(
        `SELECT id, prompt_text, visual_style AS kategori, material AS kontak, status_approval, created_at
         FROM ai_custom_designs
         WHERE prompt_text LIKE '[DESIGN SUBMISSION]%'
         ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
}));

/* ==========================================================
 * 10. 404 + ERROR HANDLER
 * ========================================================== */
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Endpoint ${req.method} ${req.path} tidak ditemukan` });
});

app.use((err, req, res, next) => {
    console.error('[ERROR]', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan di server', error: err.message });
});

/* ==========================================================
 * 11. START SERVER
 * ========================================================== */
app.listen(PORT, () => {
    console.log(`🚀 UniGift Studio API jalan di http://localhost:${PORT}`);
});