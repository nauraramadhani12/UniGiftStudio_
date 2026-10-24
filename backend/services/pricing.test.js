const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hitungBiayaCetak,
    hitungItemCustom,
    hitungItemReguler,
    hitungItemLain,
    hitungTotalInvoice,
    hitungJasaCat,
    tierCetak,
    formatRupiah,
} = require('./pricing');

// Salinan nilai seed di migrations/001_invoice_pricing.sql
const RATES = {
    cetak_batas_bawah: 20,
    cetak_batas_atas: 50,
    cetak_rate_kecil: 800,
    cetak_rate_sedang: 700,
    cetak_rate_besar: 550,
    desain_tanpa: 0,
    desain_sederhana: 16500,
    desain_basic: 23000,
    desain_standar: 34500,
    desain_kompleks: 80500,
    cat_per_warna: 8000,
    cat_warna_maks: 10,
    cat_kerumitan_basic: 5000,
    cat_kerumitan_standar: 10000,
    cat_kerumitan_menengah: 15000,
    cat_kerumitan_detail: 20000,
};

// ---------- Contoh dari spec ----------

test('contoh 1: custom 35 gr, qty 1, desain Basic, cat 3 warna, Menengah → Rp86.500', () => {
    const item = hitungItemCustom({
        berat_gram: 35, qty: 1, paket_desain: 'basic',
        pakai_cat: true, jumlah_warna: 3, tingkat_kerumitan: 'menengah',
    }, RATES);
    assert.equal(item.biaya_cetak, 24500);
    assert.equal(item.biaya_desain, 23000);
    assert.equal(item.biaya_warna, 24000);
    assert.equal(item.biaya_kerumitan, 15000);
    assert.equal(item.biaya_cat, 39000);
    assert.equal(item.subtotal, 86500);
});

test('contoh 2: custom 12 gr, qty 5, tanpa desain, tanpa cat → Rp48.000', () => {
    const item = hitungItemCustom({
        berat_gram: 12, qty: 5, paket_desain: 'tanpa', pakai_cat: false,
    }, RATES);
    assert.equal(item.biaya_cetak, 9600);
    assert.equal(item.biaya_cat, 0);
    assert.equal(item.subtotal, 48000);
});

test('contoh 3: custom 80 gr, qty 2, desain Standar, cat 1 warna, Basic → Rp183.000', () => {
    const item = hitungItemCustom({
        berat_gram: 80, qty: 2, paket_desain: 'standar',
        pakai_cat: true, jumlah_warna: 1, tingkat_kerumitan: 'basic',
    }, RATES);
    assert.equal(item.biaya_cetak, 44000);
    assert.equal(item.biaya_cat, 13000);
    assert.equal(item.subtotal, 183000);
});

test('contoh 4: batas tier cetak → 20 gr = 14.000, 50 gr = 35.000, 50,5 gr = 27.775', () => {
    assert.equal(hitungBiayaCetak(20, RATES).biaya, 14000);
    assert.equal(hitungBiayaCetak(50, RATES).biaya, 35000);
    assert.equal(hitungBiayaCetak(50.5, RATES).biaya, 27775);
});

test('contoh 5: manual campuran (custom no.1 + reguler Rp25.000 × 2 + ongkir Rp10.000) → Rp146.500', () => {
    const custom = hitungItemCustom({
        berat_gram: 35, qty: 1, paket_desain: 'basic',
        pakai_cat: true, jumlah_warna: 3, tingkat_kerumitan: 'menengah',
    }, RATES);
    const reguler = hitungItemReguler({ harga_satuan: 25000, qty: 2 });
    const total = hitungTotalInvoice([custom, reguler], { ongkir: 10000 });
    assert.equal(total.subtotal, 136500);
    assert.equal(total.total, 146500);
});

// ---------- Tier & gramasi ----------

test('tier cetak: <20 kecil, 20 dan 50 sedang, >50 besar', () => {
    assert.equal(tierCetak(19.99, RATES), 'kecil');
    assert.equal(tierCetak(20, RATES), 'sedang');
    assert.equal(tierCetak(50, RATES), 'sedang');
    assert.equal(tierCetak(50.01, RATES), 'besar');
});

test('biaya cetak dibulatkan ke rupiah terdekat', () => {
    // 33,3 gr × 700 = 23.310 (bilangan bulat), 33,33 gr × 700 = 23.331
    assert.equal(hitungBiayaCetak(33.33, RATES).biaya, 23331);
    // 12,3 gr × 800 = 9.840
    assert.equal(hitungBiayaCetak(12.3, RATES).biaya, 9840);
});

test('berat string dari form tetap diterima (dikonversi ke angka)', () => {
    const item = hitungItemCustom({
        berat_gram: '12', qty: '5', paket_desain: 'tanpa', pakai_cat: false,
    }, RATES);
    assert.equal(item.subtotal, 48000);
});

// ---------- Jasa cat ----------

test('tanpa cat → semua biaya cat 0 dan kerumitan tidak wajib', () => {
    const cat = hitungJasaCat({ pakai: false }, RATES);
    assert.deepEqual(
        [cat.biaya_warna, cat.biaya_kerumitan, cat.biaya_cat],
        [0, 0, 0],
    );
});

test('cat aktif tanpa kerumitan → ditolak', () => {
    assert.throws(
        () => hitungJasaCat({ pakai: true, jumlahWarna: 2, tingkatKerumitan: null }, RATES),
        /kerumitan/,
    );
});

test('jumlah warna di luar 1–10 → ditolak', () => {
    assert.throws(() => hitungJasaCat({ pakai: true, jumlahWarna: 0, tingkatKerumitan: 'basic' }, RATES));
    assert.throws(() => hitungJasaCat({ pakai: true, jumlahWarna: 11, tingkatKerumitan: 'basic' }, RATES));
    assert.throws(() => hitungJasaCat({ pakai: true, jumlahWarna: 2.5, tingkatKerumitan: 'basic' }, RATES));
});

test('jumlah warna 10 (batas atas) diterima', () => {
    const cat = hitungJasaCat({ pakai: true, jumlahWarna: 10, tingkatKerumitan: 'detail' }, RATES);
    assert.equal(cat.biaya_warna, 80000);
    assert.equal(cat.biaya_cat, 100000);
});

// ---------- Validasi item ----------

test('berat ≤ 0 atau kosong → ditolak', () => {
    const base = { qty: 1, paket_desain: 'basic', pakai_cat: false };
    assert.throws(() => hitungItemCustom({ ...base, berat_gram: 0 }, RATES));
    assert.throws(() => hitungItemCustom({ ...base, berat_gram: -5 }, RATES));
    assert.throws(() => hitungItemCustom({ ...base, berat_gram: '' }, RATES));
});

test('qty < 1 atau bukan bilangan bulat → ditolak', () => {
    const base = { berat_gram: 10, paket_desain: 'basic', pakai_cat: false };
    assert.throws(() => hitungItemCustom({ ...base, qty: 0 }, RATES));
    assert.throws(() => hitungItemCustom({ ...base, qty: 1.5 }, RATES));
});

test('paket desain tidak dikenal → ditolak', () => {
    assert.throws(
        () => hitungItemCustom({ berat_gram: 10, qty: 1, paket_desain: 'mewah', pakai_cat: false }, RATES),
        /Paket desain/,
    );
});

// ---------- Reguler, lain-lain, total ----------

test('reguler: harga katalog × qty, tanpa gramasi', () => {
    const item = hitungItemReguler({ harga_satuan: 25000, qty: 2 });
    assert.equal(item.subtotal, 50000);
    assert.equal(item.tipe_item, 'reguler');
});

test('lain-lain: harga bebas × qty', () => {
    const item = hitungItemLain({ harga_satuan: 7500, qty: 4 });
    assert.equal(item.subtotal, 30000);
    assert.equal(item.tipe_item, 'lain_lain');
});

test('total = subtotal + ongkir − diskon', () => {
    const items = [hitungItemReguler({ harga_satuan: 100000, qty: 1 })];
    const total = hitungTotalInvoice(items, { ongkir: 15000, diskon: 5000 });
    assert.deepEqual(total, { subtotal: 100000, ongkir: 15000, diskon: 5000, total: 110000 });
});

test('diskon lebih besar dari tagihan → ditolak', () => {
    const items = [hitungItemReguler({ harga_satuan: 10000, qty: 1 })];
    assert.throws(() => hitungTotalInvoice(items, { diskon: 20000 }), /Diskon/);
});

test('ongkir negatif → ditolak', () => {
    const items = [hitungItemReguler({ harga_satuan: 10000, qty: 1 })];
    assert.throws(() => hitungTotalInvoice(items, { ongkir: -1 }), /Ongkir/);
});

// ---------- Format rupiah ----------

test('formatRupiah: titik ribuan, tanpa desimal', () => {
    assert.equal(formatRupiah(24500), 'Rp24.500');
    assert.equal(formatRupiah(146500), 'Rp146.500');
    assert.equal(formatRupiah(1000000), 'Rp1.000.000');
    assert.equal(formatRupiah(0), 'Rp0');
    assert.equal(formatRupiah(999), 'Rp999');
});
