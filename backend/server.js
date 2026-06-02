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

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'unigiftstudio_secret_key_ganti_ini';

/* ==========================================================
 * 1. MIDDLEWARE GLOBAL
 * ========================================================== */
app.use(cors());
app.use(express.json());

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
        "SELECT COALESCE(SUM(total_bayar), 0) AS totalRevenue FROM orders WHERE status_pesanan = 'selesai'"
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
    const [[{ kontributorPending }]] = await pool.query(
        "SELECT COUNT(*) AS kontributorPending FROM contributors WHERE status = 'pending'"
    );

    res.json({
        success: true,
        data: { totalPelanggan, totalProduk, pesananHariIni, totalRevenue, statusStats, recentOrders, stokRendah, kontributorPending }
    });
}));

/* ==========================================================
 * 6. ROUTES — ADMIN USERS (admin-pengguna.html & admin-edit-pengguna.html)
 * ========================================================== */

// GET semua pengguna
app.get('/api/admin/users', verifyAdmin, asyncHandler(async(req, res) => {
    const { role, status, search } = req.query;
    let query = 'SELECT id, nama_lengkap, email, role, status_akun, created_at FROM users WHERE 1=1';
    const params = [];

    if (role) { query += ' AND role = ?';
        params.push(role); }
    if (status) { query += ' AND status_akun = ?';
        params.push(status); }
    if (search) { query += ' AND (nama_lengkap LIKE ? OR email LIKE ?)';
        params.push(`%${search}%`, `%${search}%`); }

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

    if (kategori) { query += ' AND p.kategori = ?';
        params.push(kategori); }
    if (status) { query += ' AND p.status_produk = ?';
        params.push(status); }
    if (search) { query += ' AND (p.nama_produk LIKE ? OR p.kode_produk LIKE ?)';
        params.push(`%${search}%`, `%${search}%`); }

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
    const { kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk } = req.body;
    if (!nama_produk || !harga_jual) {
        return res.status(400).json({ success: false, message: 'Nama produk dan harga jual wajib diisi.' });
    }
    try {
        const [result] = await pool.query(
            `INSERT INTO products (creator_id, kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.user.id, kode_produk || null, nama_produk, kategori || null, harga_asli || null,
                harga_jual, stok || 0, deskripsi || null, foto_url || null, status_produk || 'aktif'
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
    const { kode_produk, nama_produk, kategori, harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk } = req.body;
    if (!nama_produk || !harga_jual) {
        return res.status(400).json({ success: false, message: 'Nama produk dan harga jual wajib diisi.' });
    }
    try {
        const [result] = await pool.query(
            `UPDATE products SET kode_produk=?, nama_produk=?, kategori=?, harga_asli=?, harga_jual=?,
             stok=?, deskripsi=?, foto_url=?, status_produk=? WHERE id=?`, [kode_produk || null, nama_produk, kategori || null, harga_asli || null, harga_jual,
                stok || 0, deskripsi || null, foto_url || null, status_produk || 'aktif', req.params.id
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

    if (status) { query += ' AND o.status_pesanan = ?';
        params.push(status); }
    if (search) { query += ' AND (o.kode_pesanan LIKE ? OR o.nama_penerima LIKE ?)';
        params.push(`%${search}%`, `%${search}%`); }

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
 * 9. ROUTES — CONSUMER (endpoint sesuai file teman)
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
        'SELECT id, nama_lengkap, email, role, status_akun FROM users WHERE email = ? AND password = ?',
        [email.trim(), password]
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
        'INSERT INTO users (nama_lengkap, email, password, role, status_akun) VALUES (?, ?, ?, ?, ?)',
        [nama.trim(), email.trim(), password, 'pelanggan', 'aktif']
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
    res.json(rows[0]);
}));

/**
 * GET /api/orders/:userId  — riwayat pesanan user untuk order-history.html
 */
app.get('/api/orders/:userId', asyncHandler(async(req, res) => {
    const userId = req.params.userId;
    // Cek apakah userId adalah angka (bukan "detail")
    if (isNaN(userId)) return res.status(400).json({ pesan: 'User ID tidak valid.' });

    const [rows] = await pool.query(
        `SELECT o.*,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS jumlah_item
         FROM orders o
         WHERE o.user_id = ?
         ORDER BY o.created_at DESC`,
        [userId]
    );
    res.json(rows);
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
         WHERE oi.order_id = ?`,
        [order.id]
    );
    order.items = items;
    res.json(order);
}));

/**
 * PUT /api/orders/:orderId/pay  — simulasi bayar untuk invoice.html
 */
app.put('/api/orders/:orderId/pay', asyncHandler(async(req, res) => {
    const [result] = await pool.query(
        `UPDATE orders SET status_pesanan = 'diproses' WHERE id = ? AND status_pesanan = 'belum_bayar'`,
        [req.params.orderId]
    );
    if (result.affectedRows === 0)
        return res.status(400).json({ pesan: 'Pesanan tidak ditemukan atau sudah dibayar.' });

    res.json({ pesan: 'Pembayaran berhasil! Pesananmu sedang diproses.' });
}));

/**
 * POST /api/orders  — buat pesanan baru dari checkout.html
 * Body: { pic_id, total_tagihan, metode_pembayaran, metode_pengiriman, order_items[] }
 */
app.post('/api/orders', asyncHandler(async(req, res) => {
    const { pic_id, total_tagihan, metode_pembayaran, metode_pengiriman, order_items } = req.body;
    if (!pic_id || !total_tagihan || !order_items || order_items.length === 0)
        return res.status(400).json({ pesan: 'Data pesanan tidak lengkap.' });

    // Ambil alamat utama user
    const [addresses] = await pool.query(
        'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_utama DESC LIMIT 1', [pic_id]
    );
    const addr = addresses[0] || {};

    const kode = 'UGS-' + Math.floor(Math.random() * 90000 + 10000);

    // Support field name dari cart.html (price/quantity) maupun format lain (harga/kuantitas)
    const subtotal = order_items.reduce((s, i) => s + ((i.price || i.harga || i.harga_jual || 0) * (i.quantity || i.kuantitas || 1)), 0);
    const ongkir   = metode_pengiriman === 'Ekspres' ? 25000 : 15000;
    const layanan  = 1000;
    const total    = subtotal + ongkir + layanan;

    const [orderResult] = await pool.query(
        `INSERT INTO orders
         (user_id, kode_pesanan, nama_penerima, nomor_telepon, alamat_lengkap,
          jenis_pengiriman, metode_pembayaran, subtotal_produk, ongkos_kirim,
          biaya_layanan, total_bayar, status_pesanan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'belum_bayar')`,
        [pic_id, kode,
         addr.nama_penerima || 'Belum ada alamat',
         addr.nomor_telepon || '-',
         addr.detail_alamat ? `${addr.detail_alamat}, ${addr.wilayah}` : 'Belum ada alamat',
         metode_pengiriman, metode_pembayaran,
         subtotal, ongkir, layanan, total]
    );

    const orderId = orderResult.insertId;
    for (const item of order_items) {
        const productId  = item.id || item.product_id || null;
        const harga      = item.price || item.harga || item.harga_jual || 0;
        const qty        = item.quantity || item.kuantitas || 1;
        await pool.query(
            'INSERT INTO order_items (order_id, product_id, harga_satuan, kuantitas, varian) VALUES (?, ?, ?, ?, ?)',
            [orderId, productId, harga, qty, item.varian || null]
        );
    }

    res.status(201).json({ pesan: 'Pesanan berhasil dibuat!', kode_pesanan: kode, order_id: orderId });
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pic_id, nama_penerima, nomor_telepon || '-', label_alamat || 'Rumah',
         wilayah || '-', detail_alamat, latitude || null, longitude || null, is_utama ? 1 : 0]
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
            if (productId) {
                await pool.query(
                    'INSERT INTO carts (user_id, product_id, kuantitas) VALUES (?, ?, ?)',
                    [userId, productId, qty]
                );
            }
        }
        return res.status(201).json({ pesan: 'Keranjang berhasil disinkronisasi!' });
    }

    // Format lama — satu item
    const { product_id, kuantitas } = req.body;
    if (!product_id) return res.status(400).json({ pesan: 'Data keranjang tidak lengkap.' });
    const [existing] = await pool.query(
        'SELECT id, kuantitas FROM carts WHERE user_id = ? AND product_id = ?', [userId, product_id]
    );
    if (existing.length > 0) {
        await pool.query('UPDATE carts SET kuantitas = ? WHERE id = ?',
            [existing[0].kuantitas + (kuantitas || 1), existing[0].id]);
    } else {
        await pool.query('INSERT INTO carts (user_id, product_id, kuantitas) VALUES (?, ?, ?)',
            [userId, product_id, kuantitas || 1]);
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

    if (status) { where.push('status_produk = ?');
        params.push(status); }
    if (kategori) { where.push('kategori = ?');
        params.push(kategori); }

    const sql = `SELECT id, kode_produk, creator_id, nama_produk, kategori,
                        harga_asli, harga_jual, stok, deskripsi, foto_url, status_produk, created_at
                 FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC`;
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
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            nama_organisasi.trim(),
            tipe_organisasi || null,
            nama_pic || null,
            email.trim(),
            nomor_wa || null,
            ['Bronze','Silver','Gold'].includes(tier) ? tier : 'Silver',
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

    if (status) { query += ' AND status = ?'; params.push(status); }
    if (search)  { query += ' AND (nama_organisasi LIKE ? OR email LIKE ? OR nama_pic LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
}));

// PATCH approve / reject kontributor (admin)
app.patch('/api/admin/contributors/:id/status', verifyAdmin, asyncHandler(async(req, res) => {
    const { status, catatan_admin, tier } = req.body;

    if (!['pending','approved','rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }

    const [result] = await pool.query(
        'UPDATE contributors SET status = ?, catatan_admin = ?, tier = COALESCE(?, tier) WHERE id = ?',
        [status, catatan_admin || null, tier || null, req.params.id]
    );

    if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Pendaftar tidak ditemukan.' });
    }

    res.json({ success: true, message: `Kontributor berhasil ${status === 'approved' ? 'disetujui' : status === 'rejected' ? 'ditolak' : 'diperbarui'}.` });
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
    if (!['pending','disetujui','ditolak'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }
    await pool.query('UPDATE ai_custom_designs SET status_approval = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: 'Status berhasil diperbarui.' });
}));

/**
 * GET /api/ai-generate?prompt=...&seed=...&size=...
 * Proxy ke Pollinations.ai — hindari CORS di browser
 */
app.get('/api/ai-generate', asyncHandler(async(req, res) => {
    const { prompt, seed, size } = req.query;
    if (!prompt) return res.status(400).json({ error: 'prompt wajib diisi' });

    const px  = parseInt(size) || 512;
    const s   = seed || Math.floor(Math.random() * 999999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${px}&height=${px}&nologo=true&seed=${s}`;

    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(40000) // 40 detik timeout
        });
        if (!response.ok) throw new Error(`Pollinations error: ${response.status}`);

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await response.arrayBuffer());

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(buffer);
    } catch (err) {
        res.status(503).json({ error: 'AI sedang sibuk, coba lagi.', detail: err.message });
    }
}));

app.post('/api/ai-request', asyncHandler(async(req, res) => {
    const { user_id, creator_id, prompt_text, visual_style, kualitas, material } = req.body;
    if (!prompt_text || prompt_text.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'prompt_text wajib diisi' });
    }
    const [result] = await pool.query(
        `INSERT INTO ai_custom_designs (user_id, creator_id, prompt_text, visual_style, kualitas, material, status_approval)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`, [user_id || null, creator_id || null, prompt_text.trim(), visual_style || null, kualitas || null, material || null]
    );
    res.status(201).json({ success: true, message: 'Permintaan desain AI berhasil disimpan', id: result.insertId });
}));

/**
 * POST /api/design-submissions  (public)
 * Body: { nama, kategori, deskripsi, harga_saran, kontak }
 * Simpan kiriman desain dari Tab 2 "Upload & Earn"
 */
app.post('/api/design-submissions', asyncHandler(async(req, res) => {
    const { nama, kategori, deskripsi, harga_saran, kontak } = req.body;
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
        `INSERT INTO ai_custom_designs (prompt_text, visual_style, material, status_approval)
         VALUES (?, ?, ?, 'pending')`,
        [promptText, kategori, kontak.trim()]
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