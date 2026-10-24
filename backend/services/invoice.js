/**
 * Logika invoice untuk jalur MANUAL (Fase 2).
 * Jalur custom (Fase 3) dan reguler (Fase 4) memakai fungsi snapshot yang sama.
 *
 * Harga SELALU dihitung ulang di sini dari master harga. Nilai harga dari request
 * diabaikan, kecuali untuk item lain-lain (harga bebas, memang diinput admin).
 */

const crypto = require('crypto');
const pricing = require('./pricing');

const STATUS_TERBUKA_EDIT = ['menunggu_persetujuan', 'revisi_diminta', 'menunggu_pembayaran'];

// Alur status invoice. Setiap status hanya boleh pindah ke status di daftar ini.
const TRANSISI = {
    menunggu_persetujuan: ['batal'],
    revisi_diminta: ['batal'],
    menunggu_pembayaran: ['lunas', 'batal'],
    lunas: ['diproduksi'],
    diproduksi: ['dikirim'],
    dikirim: ['selesai'],
    selesai: [],
    batal: [],
};

const SUMBER = ['website_reguler', 'website_custom', 'manual'];

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function periodeDari(date) {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Nomor INV/UGS/YYYYMM/0001, reset tiap bulan. Dipanggil di dalam transaksi. */
async function buatNomorInvoice(conn, date = new Date()) {
    const periode = periodeDari(date);
    await conn.query(
        'INSERT INTO invoice_sequences (periode, last_no) VALUES (?, 1) ON DUPLICATE KEY UPDATE last_no = last_no + 1',
        [periode]
    );
    const [[row]] = await conn.query('SELECT last_no FROM invoice_sequences WHERE periode = ?', [periode]);
    return `INV/UGS/${periode}/${String(row.last_no).padStart(4, '0')}`;
}

function buatTokenPublik() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Ubah daftar item dari request menjadi item siap-snapshot.
 * item.tipe: 'reguler' (product_id, qty) | 'custom' (field custom) | 'lain_lain' (nama, harga_satuan, qty)
 */
async function bangunItem(conn, daftar, rates) {
    if (!Array.isArray(daftar) || daftar.length === 0) {
        throw httpError(400, 'Invoice harus punya minimal satu item.');
    }
    const hasil = [];
    for (const [i, raw] of daftar.entries()) {
        const nomor = i + 1;
        if (raw.tipe === 'reguler') {
            const [[produk]] = await conn.query(
                'SELECT id, nama_produk, harga_jual FROM products WHERE id = ?', [raw.product_id]
            );
            if (!produk) throw httpError(400, `Item ${nomor}: produk tidak ditemukan.`);
            const item = pricing.hitungItemReguler({ harga_satuan: produk.harga_jual, qty: raw.qty });
            hasil.push({ ...item, product_id: produk.id, nama_item: produk.nama_produk });
        } else if (raw.tipe === 'custom') {
            const item = pricing.hitungItemCustom(raw, rates);
            const nama = (raw.nama_item || '').trim() || 'Cetak 3D Custom';
            hasil.push({ ...item, nama_item: nama });
        } else if (raw.tipe === 'lain_lain') {
            const nama = (raw.nama_item || '').trim();
            if (!nama) throw httpError(400, `Item ${nomor}: nama item wajib diisi.`);
            const item = pricing.hitungItemLain({ harga_satuan: raw.harga_satuan, qty: raw.qty });
            hasil.push({ ...item, nama_item: nama });
        } else {
            throw httpError(400, `Item ${nomor}: tipe tidak dikenal (reguler, custom, lain_lain).`);
        }
    }
    return hasil;
}

function validasiHeader(body) {
    const nama = (body.nama_pemesan || '').trim();
    if (!nama) throw httpError(400, 'Nama pemesan wajib diisi.');
    return {
        nama_pemesan: nama,
        nomor_wa: (body.nomor_wa || '').trim() || null,
        alamat: (body.alamat || '').trim() || null,
        catatan: (body.catatan || '').trim() || null,
        ongkir: body.ongkir ?? 0,
        diskon: body.diskon ?? 0,
    };
}

/** Hitung tanpa menyimpan — dipakai untuk preview live di form admin. */
async function previewInvoice(pool, body) {
    const header = validasiHeader(body);
    const rates = await pricing.loadPricingRates(pool);
    const items = await bangunItem(pool, body.items, rates);
    const total = pricing.hitungTotalInvoice(items, { ongkir: header.ongkir, diskon: header.diskon });
    return { items, ...total };
}

async function simpanItem(conn, invoiceId, items) {
    for (const item of items) {
        await conn.query(
            `INSERT INTO invoice_items
             (invoice_id, tipe_item, product_id, nama_item, qty, harga_satuan,
              berat_gram, tier_cetak, tarif_cetak_per_gram, biaya_cetak,
              paket_desain, biaya_desain, pakai_cat, jumlah_warna, tarif_warna, biaya_warna,
              tingkat_kerumitan, biaya_kerumitan, biaya_cat, subtotal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                invoiceId, item.tipe_item, item.product_id ?? null, item.nama_item, item.qty,
                item.harga_satuan ?? 0,
                item.berat_gram ?? null, item.tier_cetak ?? null, item.tarif_cetak_per_gram ?? null, item.biaya_cetak ?? null,
                item.paket_desain ?? null, item.biaya_desain ?? null,
                item.pakai_cat ?? 0, item.jumlah_warna ?? null, item.tarif_warna ?? null, item.biaya_warna ?? null,
                item.tingkat_kerumitan ?? null, item.biaya_kerumitan ?? null, item.biaya_cat ?? null,
                item.subtotal,
            ]
        );
    }
}

/** Buat invoice manual baru. Mengembalikan id, nomor, dan token publik. */
async function buatInvoiceManual(pool, body) {
    const header = validasiHeader(body);
    const rates = await pricing.loadPricingRates(pool);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const items = await bangunItem(conn, body.items, rates);
        const total = pricing.hitungTotalInvoice(items, { ongkir: header.ongkir, diskon: header.diskon });
        const nomor = await buatNomorInvoice(conn);
        const token = buatTokenPublik();

        const [res] = await conn.query(
            `INSERT INTO invoices
             (nomor_invoice, sumber_pesanan, nama_pemesan, nomor_wa, alamat, catatan,
              subtotal, ongkir, diskon, total, status, public_token)
             VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, 'menunggu_pembayaran', ?)`,
            [nomor, header.nama_pemesan, header.nomor_wa, header.alamat, header.catatan,
             total.subtotal, total.ongkir, total.diskon, total.total, token]
        );
        await simpanItem(conn, res.insertId, items);
        await conn.commit();
        return { id: res.insertId, nomor_invoice: nomor, public_token: token, total: total.total };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** Edit invoice manual. Hanya boleh sebelum status Lunas. Item di-snapshot ulang. */
async function ubahInvoiceManual(pool, id, body) {
    const header = validasiHeader(body);
    const rates = await pricing.loadPricingRates(pool);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[inv]] = await conn.query(
            'SELECT id, status, sumber_pesanan FROM invoices WHERE id = ? FOR UPDATE', [id]
        );
        if (!inv) throw httpError(404, 'Invoice tidak ditemukan.');
        if (inv.sumber_pesanan !== 'manual') throw httpError(400, 'Invoice ini tidak bisa diedit dari halaman manual.');
        if (!STATUS_TERBUKA_EDIT.includes(inv.status)) {
            throw httpError(400, 'Invoice yang sudah Lunas atau sesudahnya tidak bisa diedit.');
        }

        const items = await bangunItem(conn, body.items, rates);
        const total = pricing.hitungTotalInvoice(items, { ongkir: header.ongkir, diskon: header.diskon });

        await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [id]);
        await conn.query(
            `UPDATE invoices SET nama_pemesan = ?, nomor_wa = ?, alamat = ?, catatan = ?,
             subtotal = ?, ongkir = ?, diskon = ?, total = ? WHERE id = ?`,
            [header.nama_pemesan, header.nomor_wa, header.alamat, header.catatan,
             total.subtotal, total.ongkir, total.diskon, total.total, id]
        );
        await simpanItem(conn, id, items);
        await conn.commit();
        return { id, total: total.total };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function ambilInvoice(pool, where, value) {
    const [[inv]] = await pool.query(`SELECT * FROM invoices WHERE ${where} = ?`, [value]);
    if (!inv) return null;
    const [items] = await pool.query(
        'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC', [inv.id]
    );
    return { ...inv, items };
}

function ambilInvoiceById(pool, id) {
    return ambilInvoice(pool, 'id', id);
}

/** Dipakai link publik. Token 64 karakter hex, tidak bisa ditebak. */
function ambilInvoiceByToken(pool, token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return Promise.resolve(null);
    return ambilInvoice(pool, 'public_token', token);
}

async function daftarInvoice(pool, { status, sumber, dari, sampai, cari } = {}) {
    let sql = `SELECT id, nomor_invoice, sumber_pesanan, nama_pemesan, nomor_wa, total,
                      status, kurir, nomor_resi, created_at
               FROM invoices WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (sumber && SUMBER.includes(sumber)) { sql += ' AND sumber_pesanan = ?'; params.push(sumber); }
    if (dari) { sql += ' AND created_at >= ?'; params.push(dari); }
    if (sampai) { sql += ' AND created_at < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(sampai); }
    if (cari) {
        sql += ' AND (nomor_invoice LIKE ? OR nama_pemesan LIKE ?)';
        params.push(`%${cari}%`, `%${cari}%`);
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    const [rows] = await pool.query(sql, params);
    return rows;
}

/** Ubah status sesuai alur. Dikirim wajib kurir. Lunas menyimpan waktu bayar. */
async function ubahStatus(pool, id, { status, kurir, nomor_resi }) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[inv]] = await conn.query('SELECT id, status FROM invoices WHERE id = ? FOR UPDATE', [id]);
        if (!inv) throw httpError(404, 'Invoice tidak ditemukan.');
        if (!(TRANSISI[inv.status] || []).includes(status)) {
            throw httpError(400, `Status tidak bisa diubah dari "${inv.status}" ke "${status}".`);
        }
        if (status === 'dikirim' && !(kurir || '').trim()) {
            throw httpError(400, 'Nama kurir wajib diisi untuk status dikirim.');
        }
        await conn.query(
            `UPDATE invoices SET status = ?,
               kurir = COALESCE(?, kurir), nomor_resi = COALESCE(?, nomor_resi),
               paid_at = CASE WHEN ? = 'lunas' THEN NOW() ELSE paid_at END
             WHERE id = ?`,
            [status, kurir || null, nomor_resi || null, status, id]
        );
        await conn.commit();
        return { id, status };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/* ==========================================================
 * JALUR CUSTOM (Fase 3)
 * Alur: request custom → Siap Produksi (disetujui) → penawaran (invoice
 * menunggu_persetujuan) → customer Setuju / Minta Revisi → Menunggu Pembayaran.
 * ========================================================== */

const NAMA_ITEM_CUSTOM = 'Cetak 3D Custom AI';

/** Hitung penawaran custom tanpa menyimpan. Dipakai untuk preview dan generate. */
async function previewPenawaranCustom(pool, body) {
    const rates = await pricing.loadPricingRates(pool);
    const item = {
        ...pricing.hitungItemCustom(body, rates),
        nama_item: (body.nama_item || '').trim() || NAMA_ITEM_CUSTOM,
    };
    const total = pricing.hitungTotalInvoice([item], { ongkir: body.ongkir ?? 0, diskon: body.diskon ?? 0 });
    return { items: [item], ...total };
}

/** Cek request custom milik actor (seller pemilik, atau admin) dan statusnya. */
async function ambilDesainCustom(conn, designId, actor, { wajibDisetujui }) {
    const [[d]] = await conn.query(
        'SELECT id, user_id, creator_id, status_approval FROM ai_custom_designs WHERE id = ?', [designId]
    );
    if (!d) throw httpError(404, 'Request custom tidak ditemukan.');
    if (actor.role !== 'admin' && Number(d.creator_id) !== Number(actor.id)) {
        throw httpError(403, 'Request ini bukan milikmu.');
    }
    if (wajibDisetujui && d.status_approval !== 'disetujui') {
        throw httpError(400, 'Validasi desain dulu (Siap Produksi) sebelum membuat penawaran.');
    }
    return d;
}

/**
 * Buat penawaran baru, atau kirim ulang penawaran setelah customer minta revisi.
 * Penawaran yang sudah Menunggu Pembayaran atau sesudahnya tidak bisa diubah.
 */
async function buatAtauRevisiPenawaran(pool, designId, body, actor) {
    const preview = await previewPenawaranCustom(pool, body);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const d = await ambilDesainCustom(conn, designId, actor, { wajibDisetujui: true });

        const [[existing]] = await conn.query(
            `SELECT id, status, nomor_invoice FROM invoices
             WHERE custom_design_id = ? AND status <> 'batal'
             ORDER BY id DESC LIMIT 1 FOR UPDATE`, [designId]
        );
        if (existing && !['menunggu_persetujuan', 'revisi_diminta'].includes(existing.status)) {
            throw httpError(400, 'Penawaran ini sudah disetujui atau dibayar, tidak bisa diubah.');
        }

        let namaPemesan = (body.nama_pemesan || '').trim();
        if (!namaPemesan && d.user_id) {
            const [[u]] = await conn.query('SELECT nama_lengkap FROM users WHERE id = ?', [d.user_id]);
            namaPemesan = u ? u.nama_lengkap : '';
        }
        namaPemesan = namaPemesan || 'Tamu';

        let invoiceId;
        let nomor;
        if (existing) {
            invoiceId = existing.id;
            nomor = existing.nomor_invoice;
            await conn.query(
                `UPDATE invoices SET status = 'menunggu_persetujuan', nama_pemesan = ?,
                 subtotal = ?, ongkir = ?, diskon = ?, total = ?, catatan = ? WHERE id = ?`,
                [namaPemesan, preview.subtotal, preview.ongkir, preview.diskon, preview.total,
                 (body.catatan || '').trim() || null, invoiceId]
            );
            await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
            // Lengkapi total_sesudah pada catatan revisi pelanggan yang terakhir
            await conn.query(
                `UPDATE invoice_revisions SET total_sesudah = ?
                 WHERE invoice_id = ? AND total_sesudah IS NULL ORDER BY id DESC LIMIT 1`,
                [preview.total, invoiceId]
            );
        } else {
            nomor = await buatNomorInvoice(conn);
            const [res] = await conn.query(
                `INSERT INTO invoices
                 (nomor_invoice, sumber_pesanan, custom_design_id, user_id, nama_pemesan, catatan,
                  subtotal, ongkir, diskon, total, status, public_token)
                 VALUES (?, 'website_custom', ?, ?, ?, ?, ?, ?, ?, ?, 'menunggu_persetujuan', ?)`,
                [nomor, designId, d.user_id, namaPemesan, (body.catatan || '').trim() || null,
                 preview.subtotal, preview.ongkir, preview.diskon, preview.total, buatTokenPublik()]
            );
            invoiceId = res.insertId;
        }
        await simpanItem(conn, invoiceId, preview.items);
        await conn.commit();
        return { id: invoiceId, nomor_invoice: nomor, total: preview.total, revisi: Boolean(existing) };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** Penawaran terakhir (non-batal) untuk satu request custom, beserta item dan riwayat revisi. */
async function ambilPenawaranDesain(pool, designId, actor) {
    await ambilDesainCustom(pool, designId, actor, { wajibDisetujui: false });
    const [[inv]] = await pool.query(
        `SELECT * FROM invoices WHERE custom_design_id = ? AND status <> 'batal'
         ORDER BY id DESC LIMIT 1`, [designId]
    );
    if (!inv) return null;
    const [items] = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = ?', [inv.id]);
    const [revisions] = await pool.query(
        'SELECT * FROM invoice_revisions WHERE invoice_id = ? ORDER BY id ASC', [inv.id]
    );
    return { ...inv, items, revisions };
}

/** Semua request custom milik pelanggan, plus penawaran terakhirnya. */
async function daftarCustomPelanggan(pool, userId) {
    const [designs] = await pool.query(
        `SELECT a.id, a.prompt_text, a.image_url, a.status_approval, a.created_at,
                u.nama_lengkap AS nama_kreator
         FROM ai_custom_designs a
         LEFT JOIN users u ON u.id = a.creator_id
         WHERE a.user_id = ? AND a.prompt_text NOT LIKE '[DESIGN SUBMISSION]%'
         ORDER BY a.created_at DESC`, [userId]
    );
    if (designs.length === 0) return [];

    const [invoices] = await pool.query(
        `SELECT * FROM invoices WHERE custom_design_id IN (?) AND status <> 'batal'
         ORDER BY id DESC`, [designs.map(d => d.id)]
    );
    const invIds = invoices.map(i => i.id);
    const [items] = invIds.length
        ? await pool.query('SELECT * FROM invoice_items WHERE invoice_id IN (?)', [invIds])
        : [[]];
    const [revisions] = invIds.length
        ? await pool.query('SELECT * FROM invoice_revisions WHERE invoice_id IN (?) ORDER BY id ASC', [invIds])
        : [[]];

    return designs.map(d => {
        const inv = invoices.find(i => i.custom_design_id === d.id) || null;
        if (inv) {
            inv.items = items.filter(s => s.invoice_id === inv.id);
            inv.revisions = revisions.filter(r => r.invoice_id === inv.id);
        }
        return { ...d, invoice: inv };
    });
}

/** Ambil invoice custom milik pelanggan, dikunci untuk update. */
async function ambilInvoiceCustomMilik(conn, invoiceId, userId) {
    const [[inv]] = await conn.query(
        'SELECT id, status, total, user_id, sumber_pesanan FROM invoices WHERE id = ? FOR UPDATE', [invoiceId]
    );
    if (!inv || inv.sumber_pesanan !== 'website_custom' || Number(inv.user_id) !== Number(userId)) {
        throw httpError(404, 'Penawaran tidak ditemukan.');
    }
    return inv;
}

async function jalankanAksiPelanggan(pool, invoiceId, userId, aksi) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const inv = await ambilInvoiceCustomMilik(conn, invoiceId, userId);
        const hasil = await aksi(conn, inv);
        await conn.commit();
        return hasil;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** Customer setuju → Menunggu Pembayaran. */
function setujuiPenawaran(pool, invoiceId, userId) {
    return jalankanAksiPelanggan(pool, invoiceId, userId, async (conn, inv) => {
        if (inv.status !== 'menunggu_persetujuan') {
            throw httpError(400, 'Penawaran ini tidak sedang menunggu persetujuan.');
        }
        await conn.query("UPDATE invoices SET status = 'menunggu_pembayaran' WHERE id = ?", [inv.id]);
        return { id: inv.id, status: 'menunggu_pembayaran' };
    });
}

/** Customer minta revisi → revisi_diminta, dicatat di riwayat revisi. */
async function mintaRevisiPenawaran(pool, invoiceId, userId, catatan) {
    const teks = (catatan || '').trim();
    if (!teks) throw httpError(400, 'Tulis catatan revisi dulu.');
    return jalankanAksiPelanggan(pool, invoiceId, userId, async (conn, inv) => {
        if (inv.status !== 'menunggu_persetujuan') {
            throw httpError(400, 'Penawaran ini tidak bisa direvisi pada status sekarang.');
        }
        const [[{ n }]] = await conn.query(
            'SELECT COUNT(*) AS n FROM invoice_revisions WHERE invoice_id = ?', [inv.id]
        );
        await conn.query(
            `INSERT INTO invoice_revisions (invoice_id, revisi_ke, diminta_oleh, catatan, total_sebelum)
             VALUES (?, ?, 'pelanggan', ?, ?)`,
            [inv.id, n + 1, teks, inv.total]
        );
        await conn.query("UPDATE invoices SET status = 'revisi_diminta' WHERE id = ?", [inv.id]);
        return { id: inv.id, status: 'revisi_diminta' };
    });
}

/** Customer upload bukti transfer. Status tetap Menunggu Pembayaran sampai admin verifikasi. */
async function kirimBuktiBayar(pool, invoiceId, userId, bukti) {
    if (!bukti) throw httpError(400, 'Bukti pembayaran wajib diupload.');
    return jalankanAksiPelanggan(pool, invoiceId, userId, async (conn, inv) => {
        if (inv.status !== 'menunggu_pembayaran') {
            throw httpError(400, 'Invoice ini belum bisa dibayar.');
        }
        await conn.query('UPDATE invoices SET bukti_pembayaran = ? WHERE id = ?', [bukti, inv.id]);
        return { id: inv.id, status: inv.status };
    });
}

module.exports = {
    SUMBER,
    TRANSISI,
    previewPenawaranCustom,
    buatAtauRevisiPenawaran,
    ambilPenawaranDesain,
    daftarCustomPelanggan,
    setujuiPenawaran,
    mintaRevisiPenawaran,
    kirimBuktiBayar,
    STATUS_TERBUKA_EDIT,
    previewInvoice,
    buatInvoiceManual,
    ubahInvoiceManual,
    ambilInvoiceById,
    ambilInvoiceByToken,
    daftarInvoice,
    ubahStatus,
};
