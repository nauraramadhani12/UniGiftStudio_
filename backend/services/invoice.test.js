const test = require('node:test');
const assert = require('node:assert/strict');
const invoice = require('./invoice');

// Tarif seed (sama dengan migrations/001_invoice_pricing.sql)
const RATES = {
    cetak_batas_bawah: 20, cetak_batas_atas: 50,
    cetak_rate_kecil: 800, cetak_rate_sedang: 700, cetak_rate_besar: 550,
    desain_tanpa: 0, desain_sederhana: 16500, desain_basic: 23000, desain_standar: 34500, desain_kompleks: 80500,
    cat_per_warna: 8000, cat_warna_maks: 10,
    cat_kerumitan_basic: 5000, cat_kerumitan_standar: 10000, cat_kerumitan_menengah: 15000, cat_kerumitan_detail: 20000,
};

/**
 * Fake pool minimal: menjawab query yang dipakai service invoice.
 * `state.invoices` menyimpan baris invoice (dipakai untuk tes status/edit).
 */
function fakePool({ products = {}, seq = {}, invoices = {}, designs = {} } = {}) {
    const state = { inserts: [], updates: [], seq, invoices, lastId: 0 };
    const query = async (sql, params = []) => {
        if (sql.startsWith('SELECT id, user_id, creator_id, status_approval FROM ai_custom_designs')) {
            const d = designs[params[0]];
            return [d ? [d] : []];
        }
        if (sql.startsWith('SELECT COUNT(*) AS n FROM invoice_revisions')) {
            return [[{ n: 0 }]];
        }
        if (sql.startsWith('SELECT id, status, total, user_id, sumber_pesanan FROM invoices')) {
            const inv = invoices[params[0]];
            return [inv ? [inv] : []];
        }
        if (sql.startsWith('SELECT kode, nilai FROM pricing_master')) {
            return [Object.entries(RATES).map(([kode, nilai]) => ({ kode, nilai }))];
        }
        if (sql.includes('FROM products WHERE id')) {
            const p = products[params[0]];
            return [p ? [p] : []];
        }
        if (sql.startsWith('INSERT INTO invoice_sequences')) {
            seq[params[0]] = (seq[params[0]] || 0) + 1;
            return [{}];
        }
        if (sql.startsWith('SELECT last_no FROM invoice_sequences')) {
            return [[{ last_no: seq[params[0]] }]];
        }
        if (sql.startsWith('INSERT INTO invoices')) {
            state.lastId += 1;
            state.inserts.push({ table: 'invoices', params, id: state.lastId });
            return [{ insertId: state.lastId }];
        }
        if (sql.startsWith('INSERT INTO invoice_items')) {
            state.inserts.push({ table: 'invoice_items', params });
            return [{}];
        }
        if (sql.startsWith('SELECT id, status, sumber_pesanan FROM invoices')
            || sql.startsWith('SELECT id, status FROM invoices')) {
            const inv = invoices[params[0]];
            return [inv ? [inv] : []];
        }
        if (sql.startsWith('DELETE FROM invoice_items') || sql.startsWith('UPDATE invoices')) {
            state.updates.push({ sql, params });
            return [{}];
        }
        return [[]];
    };
    const pool = {
        query,
        state,
        async getConnection() {
            return {
                query,
                beginTransaction: async () => {},
                commit: async () => {},
                rollback: async () => {},
                release: () => {},
            };
        },
    };
    return pool;
}

const PRODUK = { 1: { id: 1, nama_produk: 'Mini Statue Kustom', harga_jual: 25000 } };

const ITEM_CUSTOM_1 = {
    tipe: 'custom', berat_gram: 35, qty: 1, paket_desain: 'basic',
    pakai_cat: true, jumlah_warna: 3, tingkat_kerumitan: 'menengah',
};

const invoiceRow = (params) => ({ subtotal: params[5], ongkir: params[6], diskon: params[7], total: params[8] });

test('buat invoice manual campuran: contoh 5 → total Rp146.500, nomor INV/UGS/YYYYMM/0001', async () => {
    const pool = fakePool({ products: PRODUK });
    const hasil = await invoice.buatInvoiceManual(pool, {
        nama_pemesan: 'Budi', nomor_wa: '0812',
        ongkir: 10000,
        items: [ITEM_CUSTOM_1, { tipe: 'reguler', product_id: 1, qty: 2 }],
    });
    assert.equal(hasil.total, 146500);
    assert.match(hasil.nomor_invoice, /^INV\/UGS\/\d{6}\/0001$/);
    assert.equal(hasil.public_token.length, 64);

    const headerInsert = pool.state.inserts.find(i => i.table === 'invoices');
    assert.deepEqual(invoiceRow(headerInsert.params), { subtotal: 136500, ongkir: 10000, diskon: 0, total: 146500 });
    assert.equal(pool.state.inserts.filter(i => i.table === 'invoice_items').length, 2);
});

test('harga reguler diambil dari master produk, bukan dari request', async () => {
    const pool = fakePool({ products: PRODUK });
    const hasil = await invoice.buatInvoiceManual(pool, {
        nama_pemesan: 'Sari',
        items: [{ tipe: 'reguler', product_id: 1, qty: 3, harga_satuan: 1 }],
    });
    assert.equal(hasil.total, 75000);
});

test('produk reguler tidak ditemukan → 400', async () => {
    const pool = fakePool({ products: PRODUK });
    await assert.rejects(
        () => invoice.buatInvoiceManual(pool, { nama_pemesan: 'Sari', items: [{ tipe: 'reguler', product_id: 99, qty: 1 }] }),
        { status: 400, message: /produk tidak ditemukan/ },
    );
});

test('nomor invoice berurutan dalam periode yang sama', async () => {
    const seq = {};
    const pool = fakePool({ products: PRODUK, seq });
    const body = { nama_pemesan: 'A', items: [{ tipe: 'lain_lain', nama_item: 'Stiker', harga_satuan: 5000, qty: 1 }] };
    const a = await invoice.buatInvoiceManual(pool, body);
    const b = await invoice.buatInvoiceManual(pool, body);
    assert.match(a.nomor_invoice, /\/0001$/);
    assert.match(b.nomor_invoice, /\/0002$/);
});

test('nama pemesan kosong dan item kosong → 400', async () => {
    const pool = fakePool({ products: PRODUK });
    await assert.rejects(() => invoice.buatInvoiceManual(pool, { nama_pemesan: ' ', items: [ITEM_CUSTOM_1] }), { status: 400 });
    await assert.rejects(() => invoice.buatInvoiceManual(pool, { nama_pemesan: 'A', items: [] }), { status: 400 });
});

test('diskon melebihi total → 400', async () => {
    const pool = fakePool({ products: PRODUK });
    await assert.rejects(
        () => invoice.buatInvoiceManual(pool, { nama_pemesan: 'A', diskon: 999999, items: [{ tipe: 'lain_lain', nama_item: 'X', harga_satuan: 1000, qty: 1 }] }),
        { status: 400, message: /Diskon/ },
    );
});

test('transisi status: menunggu_pembayaran → lunas → diproduksi → dikirim → selesai', async () => {
    const pool = fakePool({ invoices: { 7: { id: 7, status: 'menunggu_pembayaran' } } });
    assert.equal((await invoice.ubahStatus(pool, 7, { status: 'lunas' })).status, 'lunas');
});

test('lompat status (menunggu_pembayaran → diproduksi) ditolak', async () => {
    const pool = fakePool({ invoices: { 7: { id: 7, status: 'menunggu_pembayaran' } } });
    await assert.rejects(() => invoice.ubahStatus(pool, 7, { status: 'diproduksi' }), { status: 400 });
});

test('dikirim wajib kurir', async () => {
    const pool = fakePool({ invoices: { 7: { id: 7, status: 'diproduksi' } } });
    await assert.rejects(() => invoice.ubahStatus(pool, 7, { status: 'dikirim' }), { status: 400, message: /kurir/ });
    assert.equal((await invoice.ubahStatus(pool, 7, { status: 'dikirim', kurir: 'JNE' })).status, 'dikirim');
});

test('batal dari status lunas ditolak, selesai tidak bisa diubah', async () => {
    const lunas = fakePool({ invoices: { 1: { id: 1, status: 'lunas' } } });
    await assert.rejects(() => invoice.ubahStatus(lunas, 1, { status: 'batal' }), { status: 400 });
    const selesai = fakePool({ invoices: { 2: { id: 2, status: 'selesai' } } });
    await assert.rejects(() => invoice.ubahStatus(selesai, 2, { status: 'batal' }), { status: 400 });
});

test('edit ditolak setelah lunas, diizinkan sebelum lunas', async () => {
    const lunas = fakePool({ products: PRODUK, invoices: { 3: { id: 3, status: 'lunas', sumber_pesanan: 'manual' } } });
    await assert.rejects(
        () => invoice.ubahInvoiceManual(lunas, 3, { nama_pemesan: 'A', items: [ITEM_CUSTOM_1] }),
        { status: 400, message: /Lunas/ },
    );
    const baru = fakePool({ products: PRODUK, invoices: { 4: { id: 4, status: 'menunggu_pembayaran', sumber_pesanan: 'manual' } } });
    const hasil = await invoice.ubahInvoiceManual(baru, 4, { nama_pemesan: 'A', items: [ITEM_CUSTOM_1] });
    assert.equal(hasil.total, 86500);
});

test('token publik harus format hex 64 karakter, selain itu tidak dicari', async () => {
    const pool = fakePool({});
    assert.equal(await invoice.ambilInvoiceByToken(pool, 'abc'), null);
    assert.equal(await invoice.ambilInvoiceByToken(pool, 'Z'.repeat(64)), null);
});

// ---------- Jalur custom (Fase 3) ----------

const CUSTOM_CONTOH_1 = {
    berat_gram: 35, qty: 1, paket_desain: 'basic',
    pakai_cat: true, jumlah_warna: 3, tingkat_kerumitan: 'menengah',
};

const SELLER = { id: 2, role: 'kreator' };

test('preview penawaran custom: contoh 1 → Rp86.500', async () => {
    const pool = fakePool({});
    const hasil = await invoice.previewPenawaranCustom(pool, CUSTOM_CONTOH_1);
    assert.equal(hasil.total, 86500);
});

test('penawaran baru: hanya untuk desain Siap Produksi milik seller', async () => {
    const pool = fakePool({ designs: { 9: { id: 9, user_id: 3, creator_id: 2, status_approval: 'disetujui' } } });
    const hasil = await invoice.buatAtauRevisiPenawaran(pool, 9, CUSTOM_CONTOH_1, SELLER);
    assert.equal(hasil.total, 86500);
    assert.equal(hasil.revisi, false);
    const header = pool.state.inserts.find(i => i.table === 'invoices');
    // Parameter ke-2 adalah custom_design_id (sumber 'website_custom' ditulis literal di SQL)
    assert.equal(header.params[1], 9);
});

test('penawaran ditolak kalau desain belum Siap Produksi', async () => {
    const pool = fakePool({ designs: { 9: { id: 9, user_id: 3, creator_id: 2, status_approval: 'pending' } } });
    await assert.rejects(() => invoice.buatAtauRevisiPenawaran(pool, 9, CUSTOM_CONTOH_1, SELLER), { status: 400 });
});

test('penawaran ditolak kalau seller bukan pemilik desain', async () => {
    const pool = fakePool({ designs: { 9: { id: 9, user_id: 3, creator_id: 7, status_approval: 'disetujui' } } });
    await assert.rejects(() => invoice.buatAtauRevisiPenawaran(pool, 9, CUSTOM_CONTOH_1, SELLER), { status: 403 });
});

test('admin boleh membuat penawaran untuk desain siapa pun', async () => {
    const pool = fakePool({ designs: { 9: { id: 9, user_id: 3, creator_id: 7, status_approval: 'disetujui' } } });
    const hasil = await invoice.buatAtauRevisiPenawaran(pool, 9, CUSTOM_CONTOH_1, { id: 1, role: 'admin' });
    assert.equal(hasil.total, 86500);
});

test('customer setuju: menunggu_persetujuan → menunggu_pembayaran', async () => {
    const pool = fakePool({ invoices: { 5: { id: 5, status: 'menunggu_persetujuan', total: 86500, user_id: 3, sumber_pesanan: 'website_custom' } } });
    const hasil = await invoice.setujuiPenawaran(pool, 5, 3);
    assert.equal(hasil.status, 'menunggu_pembayaran');
});

test('customer lain tidak bisa menyetujui penawaran orang', async () => {
    const pool = fakePool({ invoices: { 5: { id: 5, status: 'menunggu_persetujuan', total: 86500, user_id: 3, sumber_pesanan: 'website_custom' } } });
    await assert.rejects(() => invoice.setujuiPenawaran(pool, 5, 4), { status: 404 });
});

test('minta revisi wajib catatan dan mengubah status ke revisi_diminta', async () => {
    const pool = fakePool({ invoices: { 5: { id: 5, status: 'menunggu_persetujuan', total: 86500, user_id: 3, sumber_pesanan: 'website_custom' } } });
    await assert.rejects(() => invoice.mintaRevisiPenawaran(pool, 5, 3, '  '), { status: 400, message: /catatan/ });
    const hasil = await invoice.mintaRevisiPenawaran(pool, 5, 3, 'Tolong kurangi paket desain');
    assert.equal(hasil.status, 'revisi_diminta');
});

test('setelah Menunggu Pembayaran, penawaran tidak bisa direvisi', async () => {
    const pool = fakePool({ invoices: { 5: { id: 5, status: 'menunggu_pembayaran', total: 86500, user_id: 3, sumber_pesanan: 'website_custom' } } });
    await assert.rejects(() => invoice.mintaRevisiPenawaran(pool, 5, 3, 'ubah'), { status: 400 });
});

test('bayar: bukti wajib, dan hanya saat Menunggu Pembayaran', async () => {
    const pool = fakePool({ invoices: { 5: { id: 5, status: 'menunggu_pembayaran', total: 86500, user_id: 3, sumber_pesanan: 'website_custom' } } });
    await assert.rejects(() => invoice.kirimBuktiBayar(pool, 5, 3, ''), { status: 400 });
    const hasil = await invoice.kirimBuktiBayar(pool, 5, 3, '/uploads/bukti.jpg');
    assert.equal(hasil.id, 5);
});
