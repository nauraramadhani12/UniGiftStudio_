-- ============================================================
--  Uni Gift Studio — MIGRASI 001: INVOICE + MASTER HARGA
--  Jalankan sekali di database unigiftstudio.
--  Aman dijalankan ulang: pakai IF NOT EXISTS / INSERT IGNORE.
-- ============================================================

-- ------------------------------------------------------------
-- 1. MASTER HARGA (satu sumber untuk semua tarif)
--    Nilai dalam rupiah (kecuali batas gramasi dalam gram).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `pricing_master` (
  `kode`       varchar(60)  NOT NULL,
  `nilai`      int(11)      NOT NULL,
  `satuan`     varchar(20)  DEFAULT NULL,
  `keterangan` varchar(255) DEFAULT NULL,
  `updated_at` timestamp    NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`kode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT IGNORE INTO `pricing_master` (`kode`, `nilai`, `satuan`, `keterangan`) VALUES
  -- Biaya cetak (gramasi PLA). Tier: <20 gr = kecil, 20–50 gr = sedang, >50 gr = besar.
  ('cetak_batas_bawah',   20,    'gram',  'Batas bawah tier sedang (20 gr masuk sedang)'),
  ('cetak_batas_atas',    50,    'gram',  'Batas atas tier sedang (50 gr masuk sedang)'),
  ('cetak_rate_kecil',    800,   'rp/gr', 'Tarif cetak untuk berat < 20 gr'),
  ('cetak_rate_sedang',   700,   'rp/gr', 'Tarif cetak untuk berat 20–50 gr'),
  ('cetak_rate_besar',    550,   'rp/gr', 'Tarif cetak untuk berat > 50 gr'),
  -- Jasa desain 3D (pilih satu paket)
  ('desain_tanpa',        0,     'rp',    'Jasa desain: tanpa desain'),
  ('desain_sederhana',    16500, 'rp',    'Jasa desain: sederhana'),
  ('desain_basic',        23000, 'rp',    'Jasa desain: basic'),
  ('desain_standar',      34500, 'rp',    'Jasa desain: standar'),
  ('desain_kompleks',     80500, 'rp',    'Jasa desain: kompleks'),
  -- Jasa cat
  ('cat_per_warna',       8000,  'rp',    'Biaya per warna cat'),
  ('cat_warna_maks',      10,    'warna', 'Jumlah warna maksimal'),
  ('cat_kerumitan_basic',    5000,  'rp', 'Tambahan kerumitan: basic (bentuk simpel, detail minim)'),
  ('cat_kerumitan_standar',  10000, 'rp', 'Tambahan kerumitan: standar (ada beberapa detail kecil)'),
  ('cat_kerumitan_menengah', 15000, 'rp', 'Tambahan kerumitan: menengah (banyak detail, perlu ketelitian)'),
  ('cat_kerumitan_detail',   20000, 'rp', 'Tambahan kerumitan: detail (detail sangat kecil, pengerjaan lama)');

-- ------------------------------------------------------------
-- 2. NOMOR INVOICE (INV/UGS/YYYYMM/0001, reset tiap bulan)
--    Dipakai dengan SELECT ... FOR UPDATE dalam transaksi.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_sequences` (
  `periode`  char(6) NOT NULL,
  `last_no`  int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`periode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- 3. INVOICE (header)
--    sumber_pesanan: website_reguler | website_custom | manual
--    order_id  : diisi untuk reguler (1 invoice per baris orders)
--    custom_design_id : diisi untuk custom
--    public_token : link akses tanpa login (dipakai untuk manual & tamu)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoices` (
  `id`               int(11)      NOT NULL AUTO_INCREMENT,
  `nomor_invoice`    varchar(30)  NOT NULL,
  `sumber_pesanan`   enum('website_reguler','website_custom','manual') NOT NULL,
  `order_id`         int(11)      DEFAULT NULL,
  `custom_design_id` int(11)      DEFAULT NULL,
  `user_id`          int(11)      DEFAULT NULL,
  `nama_pemesan`     varchar(150) NOT NULL,
  `nomor_wa`         varchar(20)  DEFAULT NULL,
  `alamat`           text         DEFAULT NULL,
  `catatan`          text         DEFAULT NULL,
  `subtotal`         int(11)      NOT NULL DEFAULT 0,
  `ongkir`           int(11)      NOT NULL DEFAULT 0,
  `diskon`           int(11)      NOT NULL DEFAULT 0,
  `total`            int(11)      NOT NULL DEFAULT 0,
  `status`           enum('menunggu_persetujuan','revisi_diminta','menunggu_pembayaran',
                          'lunas','diproduksi','dikirim','selesai','batal') NOT NULL DEFAULT 'menunggu_pembayaran',
  `kurir`            varchar(100) DEFAULT NULL,
  `nomor_resi`       varchar(100) DEFAULT NULL,
  `bukti_pembayaran` varchar(255) DEFAULT NULL,
  `public_token`     char(64)     NOT NULL,
  `paid_at`          timestamp    NULL DEFAULT NULL,
  `created_at`       timestamp    NOT NULL DEFAULT current_timestamp(),
  `updated_at`       timestamp    NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_nomor_invoice` (`nomor_invoice`),
  UNIQUE KEY `uniq_public_token` (`public_token`),
  KEY `idx_invoice_order` (`order_id`),
  KEY `idx_invoice_custom` (`custom_design_id`),
  KEY `idx_invoice_user` (`user_id`),
  KEY `idx_invoice_status` (`status`),
  KEY `idx_invoice_sumber` (`sumber_pesanan`),
  CONSTRAINT `invoices_fk_order`  FOREIGN KEY (`order_id`)         REFERENCES `orders` (`id`)            ON DELETE SET NULL,
  CONSTRAINT `invoices_fk_custom` FOREIGN KEY (`custom_design_id`) REFERENCES `ai_custom_designs` (`id`) ON DELETE SET NULL,
  CONSTRAINT `invoices_fk_user`   FOREIGN KEY (`user_id`)          REFERENCES `users` (`id`)             ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- 4. INVOICE ITEM (SNAPSHOT harga)
--    Semua nilai tarif & hasil hitung disalin saat invoice dibuat,
--    supaya invoice lama tidak berubah saat tarif master diubah.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_items` (
  `id`                  int(11)      NOT NULL AUTO_INCREMENT,
  `invoice_id`          int(11)      NOT NULL,
  `tipe_item`           enum('reguler','custom','lain_lain') NOT NULL,
  `product_id`          int(11)      DEFAULT NULL,
  `custom_design_id`    int(11)      DEFAULT NULL,
  `nama_item`           varchar(255) NOT NULL,
  `qty`                 int(11)      NOT NULL DEFAULT 1,
  -- reguler / lain_lain
  `harga_satuan`        int(11)      NOT NULL DEFAULT 0,
  -- custom: gramasi & biaya cetak
  `berat_gram`          decimal(8,2) DEFAULT NULL,
  `tier_cetak`          varchar(20)  DEFAULT NULL,
  `tarif_cetak_per_gram` int(11)     DEFAULT NULL,
  `biaya_cetak`         int(11)      DEFAULT NULL,
  -- custom: jasa desain
  `paket_desain`        varchar(20)  DEFAULT NULL,
  `biaya_desain`        int(11)      DEFAULT NULL,
  -- custom: jasa cat
  `pakai_cat`           tinyint(1)   NOT NULL DEFAULT 0,
  `jumlah_warna`        tinyint(4)   DEFAULT NULL,
  `tarif_warna`         int(11)      DEFAULT NULL,
  `biaya_warna`         int(11)      DEFAULT NULL,
  `tingkat_kerumitan`   varchar(20)  DEFAULT NULL,
  `biaya_kerumitan`     int(11)      DEFAULT NULL,
  `biaya_cat`           int(11)      DEFAULT NULL,
  -- hasil akhir per baris: (cetak + desain + cat) × qty  (atau harga × qty)
  `subtotal`            int(11)      NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_invoice_item_invoice` (`invoice_id`),
  CONSTRAINT `invoice_items_fk_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `invoice_items_fk_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `invoice_items_fk_design`  FOREIGN KEY (`custom_design_id`) REFERENCES `ai_custom_designs` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- 5. RIWAYAT REVISI (custom: customer minta revisi → admin generate ulang)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_revisions` (
  `id`            int(11)      NOT NULL AUTO_INCREMENT,
  `invoice_id`    int(11)      NOT NULL,
  `revisi_ke`     int(11)      NOT NULL DEFAULT 1,
  `diminta_oleh`  enum('pelanggan','admin') NOT NULL,
  `catatan`       text         DEFAULT NULL,
  `total_sebelum` int(11)      DEFAULT NULL,
  `total_sesudah` int(11)      DEFAULT NULL,
  `created_at`    timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_revisi_invoice` (`invoice_id`),
  CONSTRAINT `invoice_revisions_fk_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------
-- 6. KOLOM TAMBAHAN di ai_custom_designs (input dari form custom)
--    Berat/qty/paket/warna/kerumitan TIDAK disimpan di sini;
--    itu diisi admin saat membuat invoice custom.
-- ------------------------------------------------------------
ALTER TABLE `ai_custom_designs`
  ADD COLUMN IF NOT EXISTS `ukuran_diinginkan`        varchar(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `mau_dicat`                tinyint(1)   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `perkiraan_jumlah_warna`   tinyint(4)   DEFAULT NULL;
