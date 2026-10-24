/**
 * Modul perhitungan harga — satu sumber untuk jalur CUSTOM dan MANUAL.
 *
 * Semua fungsi di sini murni (tanpa akses DB) kecuali loadPricingRates().
 * Tarif dikirim sebagai object `rates` (hasil loadPricingRates dari tabel pricing_master),
 * sehingga unit test bisa memakai tarif tetap tanpa database.
 *
 * Aturan:
 *  - biaya_cetak   = berat_gram × tarif_tier   (dibulatkan ke rupiah terdekat)
 *  - jasa_desain   = paket desain (pilih 1)
 *  - biaya_cat     = jumlah_warna × tarif_warna + tambahan_kerumitan (0 kalau tanpa cat)
 *  - subtotal item = (biaya_cetak + biaya_desain + biaya_cat) × qty
 *  - total invoice = Σ subtotal + ongkir − diskon
 */

const PAKET_DESAIN = ['tanpa', 'sederhana', 'basic', 'standar', 'kompleks'];
const TINGKAT_KERUMITAN = ['basic', 'standar', 'menengah', 'detail'];

const RATE_KEYS = [
    'cetak_batas_bawah', 'cetak_batas_atas',
    'cetak_rate_kecil', 'cetak_rate_sedang', 'cetak_rate_besar',
    'desain_tanpa', 'desain_sederhana', 'desain_basic', 'desain_standar', 'desain_kompleks',
    'cat_per_warna', 'cat_warna_maks',
    'cat_kerumitan_basic', 'cat_kerumitan_standar', 'cat_kerumitan_menengah', 'cat_kerumitan_detail',
];

function hitungError(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

function angkaPositif(value, nama) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw hitungError(`${nama} harus lebih dari 0.`);
    return n;
}

function bilanganBulatMin(value, min, nama) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw hitungError(`${nama} harus bilangan bulat minimal ${min}.`);
    return n;
}

function rupiahNonNegatif(value, nama) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw hitungError(`${nama} tidak boleh negatif.`);
    return Math.round(n);
}

/**
 * Ambil semua tarif dari tabel pricing_master.
 * Melempar error kalau ada kode yang belum ter-seed (migrasi belum dijalankan).
 */
async function loadPricingRates(pool) {
    const [rows] = await pool.query('SELECT kode, nilai FROM pricing_master');
    const rates = Object.fromEntries(rows.map(r => [r.kode, Number(r.nilai)]));
    const hilang = RATE_KEYS.filter(k => !(k in rates));
    if (hilang.length) throw new Error(`pricing_master belum lengkap, kode hilang: ${hilang.join(', ')}`);
    return rates;
}

/** Tier cetak berdasarkan berat: <20 kecil, 20–50 sedang (batas ikut), >50 besar. */
function tierCetak(gram, rates) {
    if (gram < rates.cetak_batas_bawah) return 'kecil';
    if (gram <= rates.cetak_batas_atas) return 'sedang';
    return 'besar';
}

/** Biaya cetak PLA. Mengembalikan tier, tarif per gram, dan biaya total. */
function hitungBiayaCetak(beratGram, rates) {
    const gram = angkaPositif(beratGram, 'Berat (gr)');
    const tier = tierCetak(gram, rates);
    const tarif = rates[`cetak_rate_${tier}`];
    return { tier, tarif, biaya: Math.round(gram * tarif) };
}

/** Jasa desain 3D (pilih satu paket). */
function hitungJasaDesain(paket, rates) {
    if (!PAKET_DESAIN.includes(paket)) {
        throw hitungError(`Paket desain tidak valid. Pilihan: ${PAKET_DESAIN.join(', ')}.`);
    }
    return { paket, biaya: rates[`desain_${paket}`] };
}

/**
 * Jasa cat. Kalau tanpa cat, semua biaya 0.
 * Kalau pakai cat: jumlah warna (1..cat_warna_maks) dan tingkat kerumitan wajib diisi.
 */
function hitungJasaCat({ pakai, jumlahWarna, tingkatKerumitan }, rates) {
    if (!pakai) {
        return {
            pakai: false, jumlah_warna: null, tarif_warna: null, biaya_warna: 0,
            tingkat_kerumitan: null, biaya_kerumitan: 0, biaya_cat: 0,
        };
    }
    const warna = bilanganBulatMin(jumlahWarna, 1, 'Jumlah warna');
    if (warna > rates.cat_warna_maks) {
        throw hitungError(`Jumlah warna maksimal ${rates.cat_warna_maks}.`);
    }
    if (!TINGKAT_KERUMITAN.includes(tingkatKerumitan)) {
        throw hitungError(`Tingkat kerumitan wajib dipilih. Pilihan: ${TINGKAT_KERUMITAN.join(', ')}.`);
    }
    const biayaWarna = warna * rates.cat_per_warna;
    const biayaKerumitan = rates[`cat_kerumitan_${tingkatKerumitan}`];
    return {
        pakai: true,
        jumlah_warna: warna,
        tarif_warna: rates.cat_per_warna,
        biaya_warna: biayaWarna,
        tingkat_kerumitan: tingkatKerumitan,
        biaya_kerumitan: biayaKerumitan,
        biaya_cat: biayaWarna + biayaKerumitan,
    };
}

/**
 * Satu item custom lengkap. Field output memakai nama kolom tabel invoice_items
 * supaya bisa langsung di-INSERT sebagai snapshot.
 *
 * input: { berat_gram, qty, paket_desain, pakai_cat, jumlah_warna, tingkat_kerumitan }
 */
function hitungItemCustom(input, rates) {
    const qty = bilanganBulatMin(input.qty, 1, 'Qty');
    const cetak = hitungBiayaCetak(input.berat_gram, rates);
    const desain = hitungJasaDesain(input.paket_desain, rates);
    const cat = hitungJasaCat({
        pakai: Boolean(input.pakai_cat),
        jumlahWarna: input.jumlah_warna,
        tingkatKerumitan: input.tingkat_kerumitan,
    }, rates);

    const satuan = cetak.biaya + desain.biaya + cat.biaya_cat;
    return {
        tipe_item: 'custom',
        qty,
        berat_gram: Number(input.berat_gram),
        tier_cetak: cetak.tier,
        tarif_cetak_per_gram: cetak.tarif,
        biaya_cetak: cetak.biaya,
        paket_desain: desain.paket,
        biaya_desain: desain.biaya,
        pakai_cat: cat.pakai ? 1 : 0,
        jumlah_warna: cat.jumlah_warna,
        tarif_warna: cat.tarif_warna,
        biaya_warna: cat.biaya_warna,
        tingkat_kerumitan: cat.tingkat_kerumitan,
        biaya_kerumitan: cat.biaya_kerumitan,
        biaya_cat: cat.biaya_cat,
        subtotal: satuan * qty,
    };
}

/** Item reguler: harga katalog × qty. Tidak memakai gramasi. */
function hitungItemReguler({ harga_satuan, qty }) {
    const harga = rupiahNonNegatif(harga_satuan, 'Harga satuan');
    const jumlah = bilanganBulatMin(qty, 1, 'Qty');
    return { tipe_item: 'reguler', harga_satuan: harga, qty: jumlah, subtotal: harga * jumlah };
}

/** Item lain-lain (di luar price list): nama + harga bebas × qty. */
function hitungItemLain({ harga_satuan, qty }) {
    const item = hitungItemReguler({ harga_satuan, qty });
    return { ...item, tipe_item: 'lain_lain' };
}

/** Total invoice: Σ subtotal item + ongkir − diskon. */
function hitungTotalInvoice(items, { ongkir = 0, diskon = 0 } = {}) {
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const ongkirFinal = rupiahNonNegatif(ongkir, 'Ongkir');
    const diskonFinal = rupiahNonNegatif(diskon, 'Diskon');
    const total = subtotal + ongkirFinal - diskonFinal;
    if (total < 0) throw hitungError('Diskon melebihi total tagihan.');
    return { subtotal, ongkir: ongkirFinal, diskon: diskonFinal, total };
}

/** Format rupiah: Rp24.500 (titik ribuan, tanpa desimal). */
function formatRupiah(angka) {
    const n = Math.round(Number(angka) || 0);
    const tanda = n < 0 ? '-' : '';
    const teks = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${tanda}Rp${teks}`;
}

module.exports = {
    PAKET_DESAIN,
    TINGKAT_KERUMITAN,
    RATE_KEYS,
    loadPricingRates,
    tierCetak,
    hitungBiayaCetak,
    hitungJasaDesain,
    hitungJasaCat,
    hitungItemCustom,
    hitungItemReguler,
    hitungItemLain,
    hitungTotalInvoice,
    formatRupiah,
};
