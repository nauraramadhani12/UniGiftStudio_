-- ============================================================
--  Uni Gift Studio — UNIFIED DATABASE
--  Generated : 2026-05-24
--  Server    : MariaDB 10.4 / MySQL 8
--  Charset   : utf8mb4
--
--  Perubahan dari versi sebelumnya:
--    ✅ Tabel filaments  → DIHAPUS (fitur dihilangkan)
--    ✅ Tabel printers   → DIHAPUS (fitur dihilangkan)
--    ✅ Tabel contributors → DITAMBAHKAN (fitur baru)
--    ✅ Data users lengkap dengan role yang benar
--    ✅ Data produk, pesanan, ulasan lebih lengkap
--    ✅ Email bug fixed, index duplikat dibersihkan
-- ============================================================

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";
SET NAMES utf8mb4;

-- ============================================================
-- Buat / Gunakan database
-- ============================================================
CREATE DATABASE IF NOT EXISTS `unigiftstudio`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE `unigiftstudio`;

-- ============================================================
-- Drop semua tabel (urutan aman: anak dulu, lalu induk)
-- ============================================================
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `contributors`;
DROP TABLE IF EXISTS `reviews`;
DROP TABLE IF EXISTS `order_items`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `carts`;
DROP TABLE IF EXISTS `ai_custom_designs`;
DROP TABLE IF EXISTS `filaments`;
DROP TABLE IF EXISTS `printers`;
DROP TABLE IF EXISTS `user_addresses`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `users`;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 1. USERS
-- ============================================================
CREATE TABLE `users` (
  `id`          int(11)       NOT NULL AUTO_INCREMENT,
  `nama_lengkap` varchar(100) NOT NULL,
  `email`       varchar(100)  NOT NULL,
  `password`    varchar(255)  NOT NULL,
  `role`        enum('pelanggan','kreator','admin') NOT NULL DEFAULT 'pelanggan',
  `status_akun` enum('aktif','diblokir') DEFAULT 'aktif',
  `created_at`  timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `users` (`id`, `nama_lengkap`, `email`, `password`, `role`, `status_akun`, `created_at`) VALUES
(1,  'Admin Utama',    'admin@unigift.com',   'pass123', 'admin',     'aktif', '2026-04-25 04:25:12'),
(2,  'Amadea Kreator', 'amadea@unigift.com',  'pass123', 'kreator',   'aktif', '2026-04-25 04:25:12'),
(3,  'Rizky Billar',   'rizky@email.com',     'pass123', 'pelanggan', 'aktif', '2026-04-25 04:25:12'),
(4,  'Lesti Kejora',   'lesti@email.com',     'pass123', 'pelanggan', 'aktif', '2026-04-25 04:25:12'),
(5,  'Budi Santoso',   'budi@email.com',      'pass123', 'pelanggan', 'aktif', '2026-04-25 04:25:12'),
(6,  'Naura Ramadhani','naura@email.com',     'pass123', 'pelanggan', 'aktif', '2026-04-25 04:25:12'),
(7,  'Andi Wijaya',    'andi@email.com',      'pass123', 'pelanggan', 'aktif', '2026-04-25 04:25:12');

-- ============================================================
-- 2. USER ADDRESSES
-- ============================================================
CREATE TABLE `user_addresses` (
  `id`            int(11)       NOT NULL AUTO_INCREMENT,
  `user_id`       int(11)       DEFAULT NULL,
  `nama_penerima` varchar(100)  NOT NULL,
  `nomor_telepon` varchar(20)   NOT NULL,
  `label_alamat`  enum('Rumah','Kantor','Lainnya') DEFAULT 'Rumah',
  `wilayah`       varchar(255)  NOT NULL,
  `detail_alamat` text          NOT NULL,
  `latitude`      varchar(50)   DEFAULT NULL,
  `longitude`     varchar(50)   DEFAULT NULL,
  `is_utama`      tinyint(1)    DEFAULT 0,
  `created_at`    timestamp     NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `user_addresses_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ============================================================
-- 3. PRODUCTS
-- ============================================================
CREATE TABLE `products` (
  `id`             int(11)      NOT NULL AUTO_INCREMENT,
  `creator_id`     int(11)      DEFAULT NULL,
  `kode_produk`    varchar(50)  DEFAULT NULL,
  `nama_produk`    varchar(255) NOT NULL,
  `kategori`       varchar(100) DEFAULT NULL,
  `harga_asli`     int(11)      DEFAULT NULL,
  `harga_jual`     int(11)      NOT NULL,
  `stok`           int(11)      DEFAULT 0,
  `deskripsi`      text         DEFAULT NULL,
  `foto_url`       varchar(255) DEFAULT NULL,
  `varian_label`   varchar(100) DEFAULT NULL,
  `varian_opsi`    text         DEFAULT NULL,
  `teks_kustom_max` int(11)     DEFAULT 0,
  `status_produk`  enum('aktif','habis','nonaktif') DEFAULT 'aktif',
  `created_at`     timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `kode_produk` (`kode_produk`),
  KEY `creator_id` (`creator_id`),
  CONSTRAINT `products_ibfk_1` FOREIGN KEY (`creator_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `products` (`id`, `creator_id`, `kode_produk`, `nama_produk`, `kategori`, `harga_asli`, `harga_jual`, `stok`, `deskripsi`, `foto_url`, `status_produk`, `created_at`) VALUES
(1, 2, 'PRD-001', 'Mini Statue Kustom',      'Mini Statue',    180000, 150000,  8, 'Pajangan meja estetik dari resin kualitas tinggi.', 'https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=400&q=80', 'aktif', '2026-04-25 04:25:12'),
(2, 2, 'PRD-002', 'Gantungan Kunci Inisial', 'Gantungan Kunci', NULL,   30000, 50, 'Aksesori minimalis dengan inisial nama.', 'https://images.unsplash.com/photo-1579811216948-6f57c19376a5?auto=format&fit=crop&w=400&q=80', 'aktif', '2026-04-25 04:25:12'),
(3, 2, 'PRD-003', 'Night Ride Glow Tag',     'Gantungan Kunci', NULL,   45000, 30, 'Gantungan menyala saat gelap, cocok untuk biker.', NULL, 'aktif', '2026-04-25 04:25:12'),
(4, 2, 'PRD-004', 'Custom Pattern Socks',    'Kaos Kaki',       NULL,   85000, 25, 'Kaos kaki dengan pola desain AI eksklusif.', NULL, 'aktif', '2026-04-25 04:25:12'),
(5, 2, 'PRD-005', 'Robot Desktop MK-1',      'Mini Statue',    300000, 250000, 12, 'Action figure robot low-poly untuk meja kerja.', NULL, 'aktif', '2026-04-25 04:25:12'),
(6, 2, 'PRD-006', 'Vas Bunga Geometris',     'Mini Statue',     NULL,  120000,  3, 'Vas bunga 3D printed dengan pola geometri.', NULL, 'aktif', '2026-04-25 04:25:12');

-- ============================================================
-- 4. ORDERS
-- ============================================================
CREATE TABLE `orders` (
  `id`                int(11)      NOT NULL AUTO_INCREMENT,
  `user_id`           int(11)      DEFAULT NULL,
  `kode_pesanan`      varchar(50)  NOT NULL,
  `nama_penerima`     varchar(150) NOT NULL,
  `nomor_telepon`     varchar(20)  NOT NULL,
  `alamat_lengkap`    text         NOT NULL,
  `latitude`          varchar(50)  DEFAULT NULL,
  `longitude`         varchar(50)  DEFAULT NULL,
  `pesan_pembeli`     text         DEFAULT NULL,
  `jenis_pengiriman`  varchar(50)  DEFAULT NULL,
  `metode_pembayaran` varchar(50)  DEFAULT NULL,
  `subtotal_produk`   int(11)      NOT NULL,
  `diskon`            int(11)      DEFAULT 0,
  `ongkos_kirim`      int(11)      DEFAULT 0,
  `biaya_layanan`     int(11)      DEFAULT 1000,
  `total_bayar`       int(11)      NOT NULL,
  `status_pesanan`    enum('belum_bayar','diproses','dikirim','selesai','dibatalkan') DEFAULT 'belum_bayar',
  `kurir`             varchar(100) DEFAULT NULL,
  `nomor_resi`        varchar(100) DEFAULT NULL,
  `created_at`        timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `kode_pesanan` (`kode_pesanan`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `orders` (`id`, `user_id`, `kode_pesanan`, `nama_penerima`, `nomor_telepon`, `alamat_lengkap`, `pesan_pembeli`, `jenis_pengiriman`, `metode_pembayaran`, `subtotal_produk`, `diskon`, `ongkos_kirim`, `biaya_layanan`, `total_bayar`, `status_pesanan`, `kurir`, `nomor_resi`, `created_at`) VALUES
(1, 3, 'UNI-992',   'Rizky Billar',  '08123456789', 'Jl. Kemang Raya No. 12, Jakarta',   NULL, 'Reguler', 'BCA Virtual Account', 30000,   0, 15000, 1000,  46000,  'diproses',    'JNE',     NULL,           '2026-04-22 03:30:00'),
(2, 4, 'UNI-991',   'Lesti Kejora',  '08234567890', 'Jl. Dago No. 45, Bandung',          NULL, 'Reguler', 'Gopay',              175000,   0, 20000, 1000, 196000,  'belum_bayar', NULL,      NULL,           '2026-04-23 07:15:00'),
(3, 5, 'UNI-990',   'Budi Santoso',  '08345678901', 'Jl. Pandanaran No. 8, Semarang',    NULL, 'Reguler', 'BCA Virtual Account',120000, 10000, 18000, 1000, 129000,  'selesai',     'SiCepat', 'SC123456789',  '2026-04-18 02:00:00'),
(4, 6, 'UGS-10293', 'Naura Ramadhani','08581111111','Jl. Sabang No. 22, Jakarta',        NULL, 'Reguler', 'OVO',                130000,   0, 15000, 1000, 146000,  'belum_bayar', NULL,      NULL,           '2026-04-24 09:45:00'),
(5, 5, 'UGS-10292', 'Budi Santoso',  '08345678901', 'Jl. Pandanaran No. 8, Semarang',    NULL, 'Reguler', 'BCA Virtual Account', 30000,   0, 15000, 1000,  46000,  'diproses',    'JNE',     NULL,           '2026-04-21 04:20:00'),
(6, 7, 'UGS-10291', 'Andi Wijaya',   '08456789012', 'Jl. Malioboro No. 100, Yogyakarta', NULL, 'Ekspres', 'Bank Transfer',       150000,   0, 20000, 1000, 171000,  'dikirim',     'JNT',     'JT987654321',  '2026-04-19 06:00:00'),
(7, 4, 'UGS-10290', 'Lesti Kejora',  '08234567890', 'Jl. Dago No. 45, Bandung',          NULL, 'Reguler', 'Gopay',               85000,   0, 18000, 1000, 104000,  'dibatalkan',  NULL,      NULL,           '2026-04-17 01:30:00');

-- ============================================================
-- 5. ORDER ITEMS
-- ============================================================
CREATE TABLE `order_items` (
  `id`           int(11)      NOT NULL AUTO_INCREMENT,
  `order_id`     int(11)      DEFAULT NULL,
  `product_id`   int(11)      DEFAULT NULL,
  `varian`       varchar(100) DEFAULT NULL,
  `teks_kustom`  varchar(255) DEFAULT NULL,
  `harga_satuan` int(11)      NOT NULL,
  `kuantitas`    int(11)      NOT NULL,
  PRIMARY KEY (`id`),
  KEY `order_id` (`order_id`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `order_items_ibfk_1` FOREIGN KEY (`order_id`)   REFERENCES `orders`   (`id`) ON DELETE CASCADE,
  CONSTRAINT `order_items_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `order_items` (`id`, `order_id`, `product_id`, `varian`, `teks_kustom`, `harga_satuan`, `kuantitas`) VALUES
(1, 1, 2, 'Standard', 'RB',  30000, 1),
(2, 2, 5, 'Premium',  NULL, 175000, 1),
(3, 3, 6, 'Standard', NULL, 120000, 1),
(4, 4, 1, 'Standard', NULL, 130000, 1),
(5, 5, 3, NULL,       NULL,  30000, 1),
(6, 6, 1, 'Premium',  'AW', 150000, 1),
(7, 7, 4, 'Standard', NULL,  85000, 1);

-- ============================================================
-- 6. CARTS
-- ============================================================
CREATE TABLE `carts` (
  `id`         int(11) NOT NULL AUTO_INCREMENT,
  `user_id`    int(11) DEFAULT NULL,
  `product_id` int(11) DEFAULT NULL,
  `kuantitas`  int(11) DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `product_id` (`product_id`),
  CONSTRAINT `carts_ibfk_1` FOREIGN KEY (`user_id`)    REFERENCES `users`    (`id`) ON DELETE CASCADE,
  CONSTRAINT `carts_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ============================================================
-- 7. AI CUSTOM DESIGNS
-- ============================================================
CREATE TABLE `ai_custom_designs` (
  `id`              int(11)      NOT NULL AUTO_INCREMENT,
  `user_id`         int(11)      DEFAULT NULL,
  `creator_id`      int(11)      DEFAULT NULL,
  `prompt_text`     text         NOT NULL,
  `visual_style`    varchar(100) DEFAULT NULL,
  `kualitas`        varchar(50)  DEFAULT NULL,
  `material`        varchar(100) DEFAULT NULL,
  `image_url`       varchar(255) DEFAULT NULL,
  `status_approval` enum('pending','disetujui','ditolak') DEFAULT 'pending',
  `created_at`      timestamp    NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `creator_id` (`creator_id`),
  CONSTRAINT `ai_custom_designs_ibfk_1` FOREIGN KEY (`user_id`)    REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ai_custom_designs_ibfk_2` FOREIGN KEY (`creator_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `ai_custom_designs` (`id`, `user_id`, `creator_id`, `prompt_text`, `visual_style`, `kualitas`, `material`, `status_approval`, `created_at`) VALUES
(1, 3, 2, 'Action figure astronot meditasi gaya low-poly',    'Minimalist 3D',  'Ultra Max', 'PLA Matte',      'pending',   '2026-04-23 02:00:00'),
(2, 4, 2, 'Gantungan kunci inisial L cyber neon',             'Cyberpunk',      'Ultra Max', 'Resin Crystal',  'disetujui', '2026-04-21 04:00:00'),
(3, 5, 2, 'Vas bunga bentuk spiral fibonacci',                'Photorealistic', 'Draft',     'PLA Matte',      'pending',   '2026-04-24 07:30:00'),
(4, NULL, NULL, 'kucing lucu bikin gantungan kunci',          'Minimalist 3D',  'Ultra Max', 'PLA Matte',      'pending',   '2026-04-25 06:23:36'),
(5, NULL, NULL, 'gantungan kucing lucu warna oranye ekspresi lucu', 'Photorealistic', 'Ultra Max', 'PLA Matte', 'pending',  '2026-04-25 06:32:24');

-- ============================================================
-- 8. REVIEWS
-- ============================================================
CREATE TABLE `reviews` (
  `id`         int(11) NOT NULL AUTO_INCREMENT,
  `user_id`    int(11) DEFAULT NULL,
  `product_id` int(11) DEFAULT NULL,
  `order_id`   int(11) DEFAULT NULL,
  `rating`     int(11) NOT NULL CHECK (`rating` >= 1 AND `rating` <= 5),
  `komentar`   text    DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `product_id` (`product_id`),
  KEY `order_id` (`order_id`),
  CONSTRAINT `reviews_ibfk_1` FOREIGN KEY (`user_id`)    REFERENCES `users`    (`id`) ON DELETE CASCADE,
  CONSTRAINT `reviews_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `reviews_ibfk_3` FOREIGN KEY (`order_id`)   REFERENCES `orders`   (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `reviews` (`id`, `user_id`, `product_id`, `order_id`, `rating`, `komentar`, `created_at`) VALUES
(1, 5, 6, 3, 5, 'Vas bunganya bagus banget, cetakan rapi!', '2026-04-19 03:00:00'),
(2, 7, 1, 6, 4, 'Mini statue keren, sesuai foto.',          '2026-04-20 08:30:00');

-- ============================================================
-- 9. CONTRIBUTORS  ← BARU: untuk fitur "Jadi Kontributor"
-- ============================================================
CREATE TABLE `contributors` (
  `id`              int(11)      NOT NULL AUTO_INCREMENT,
  `nama_organisasi` varchar(200) NOT NULL,
  `tipe_organisasi` varchar(100) DEFAULT NULL,
  `nama_pic`        varchar(100) DEFAULT NULL,
  `email`           varchar(100) NOT NULL,
  `nomor_wa`        varchar(20)  DEFAULT NULL,
  `tier`            enum('Bronze','Silver','Gold') DEFAULT 'Silver',
  `pesan`           text         DEFAULT NULL,
  `status`          enum('pending','disetujui','ditolak') DEFAULT 'pending',
  `catatan_admin`   text         DEFAULT NULL,
  `created_at`      timestamp    NOT NULL DEFAULT current_timestamp(),
  `updated_at`      timestamp    NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Contoh data kontributor (opsional, boleh dihapus)
INSERT INTO `contributors` (`id`, `nama_organisasi`, `tipe_organisasi`, `nama_pic`, `email`, `nomor_wa`, `tier`, `pesan`, `status`, `created_at`) VALUES
(1, 'HIMA Teknik Informatika ITB', 'Himpunan Mahasiswa', 'Budi Santoso', 'hima.ti@itb.ac.id',  '081234567890', 'Silver', 'Kami ingin memesan souvenir wisuda batch 2026.', 'pending',    '2026-05-01 08:00:00'),
(2, 'CV. Kreasi Nusantara',        'UMKM',              'Siti Rahma',   'kreasi@nusantara.id', '089876543210', 'Gold',   'Tertarik untuk kerjasama reseller jangka panjang.', 'disetujui', '2026-05-10 10:30:00');

COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
