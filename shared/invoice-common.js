/**
 * Helper invoice yang dipakai bersama halaman admin (seller/) dan halaman customer (consumer/).
 * Hanya tampilan — perhitungan harga tetap di backend.
 */
const INVOICE_STATUS = {
    menunggu_persetujuan: { label: 'Menunggu Persetujuan', cls: 'bg-orange-100 text-orange-700' },
    revisi_diminta:       { label: 'Revisi Diminta',       cls: 'bg-purple-100 text-purple-700' },
    menunggu_pembayaran:  { label: 'Menunggu Pembayaran',  cls: 'bg-red-100 text-red-600' },
    lunas:                { label: 'Lunas',                cls: 'bg-green-100 text-green-700' },
    diproduksi:           { label: 'Diproduksi',           cls: 'bg-yellow-100 text-yellow-700' },
    dikirim:              { label: 'Dikirim',              cls: 'bg-blue-100 text-blue-600' },
    selesai:              { label: 'Selesai',              cls: 'bg-emerald-100 text-emerald-700' },
    batal:                { label: 'Batal',                cls: 'bg-slate-200 text-slate-600' },
};

const INVOICE_SUMBER = {
    website_reguler: 'Website - Reguler',
    website_custom:  'Website - Custom',
    manual:          'Manual (WA/Internal)',
};

// Status yang masih boleh diedit (sebelum Lunas). Sama dengan STATUS_TERBUKA_EDIT di backend.
const INVOICE_EDITABLE = ['menunggu_persetujuan', 'revisi_diminta', 'menunggu_pembayaran'];

// Langkah berikutnya per status. Sama dengan TRANSISI di backend.
const INVOICE_NEXT = {
    menunggu_persetujuan: ['batal'],
    revisi_diminta: ['batal'],
    menunggu_pembayaran: ['lunas', 'batal'],
    lunas: ['diproduksi'],
    diproduksi: ['dikirim'],
    dikirim: ['selesai'],
    selesai: [],
    batal: [],
};

const INVOICE_TIER_LABEL = { kecil: '< 20 gr', sedang: '20–50 gr', besar: '> 50 gr' };
const INVOICE_PAKET_LABEL = {
    tanpa: 'Tanpa desain', sederhana: 'Sederhana', basic: 'Basic', standar: 'Standar', kompleks: 'Kompleks',
};
const INVOICE_KERUMITAN_LABEL = { basic: 'Basic', standar: 'Standar', menengah: 'Menengah', detail: 'Detail' };

/** Escape teks dari input pengguna sebelum dimasukkan ke HTML. */
function esc(teks) {
    return String(teks ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Format rupiah: Rp24.500 */
function rupiah(angka) {
    const n = Math.round(Number(angka) || 0);
    return (n < 0 ? '-' : '') + 'Rp' + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const NAMA_BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** Tanggal dari MySQL ("YYYY-MM-DD HH:MM:SS") → "24 Okt 2026" */
function tanggalInvoice(teks) {
    if (!teks) return '—';
    const d = new Date(String(teks).replace(' ', 'T'));
    if (isNaN(d)) return teks;
    return `${String(d.getDate()).padStart(2, '0')} ${NAMA_BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

function badgeStatus(status) {
    const s = INVOICE_STATUS[status] || { label: status, cls: 'bg-slate-100 text-slate-600' };
    return `<span class="${s.cls} px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap">${s.label}</span>`;
}

/** Nomor WA Indonesia → format wa.me (62...). Kosong kalau tidak valid. */
function nomorWaInternasional(nomor) {
    const digit = String(nomor || '').replace(/\D/g, '');
    if (!digit) return '';
    if (digit.startsWith('62')) return digit;
    if (digit.startsWith('0')) return '62' + digit.slice(1);
    return digit;
}
