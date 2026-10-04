# Sabah Masası — Prompt eki (yalnızca kaynak toplama yöntemi)

Aşağıdaki blok mevcut promptun **sonuna** eklenir. İçerik, üslup, bölüm ve
takvim talimatlarına dokunmaz; yalnızca malzemenin hangi sırayla ve hangi
araçlarla toplanacağını belirler.

---

## KAYNAK TOPLAMA YÖNTEMİ
Bu bölüm yukarıdaki içerik talimatlarını değiştirmez; yalnızca malzemenin nasıl toplanacağını belirler. İçerik kalitesi her zaman tasarruftan önce gelir.

### Katman 1 — Akış (her zaman ilk adım)
1. `feed_health` çağır. Veri 3 saatten eskiyse ya da bir dilde çalışan kaynak kalmadıysa not al; bunu Katman 2'de telafi et.
2. `sabah_digest` çağır (varsayılan ayarlarla: pencere ve günün bölümleri otomatik gelir). Bu liste günün ana malzemesidir; web_search'ten önce gelir.
3. Akış içinde bir konuyu derinleştirmen gerekirse önce `feed_search`; akışta temsil edilmeyen bir dil ya da ülke için `gdelt_search` kullan.

### Katman 2 — Denetim ve tamamlama
4. Yazmaya başlamadan önce, bu promptun talimatlarına karşı kendine bir kontrol listesi çıkar (bültene yazma):
   a. Bugün çıkması gereken her bölüm için yeterli ve analiz edilebilir malzeme var mı? Digest sonundaki "BOŞ BÖLÜM" uyarılarına bak.
   b. Sekiz tarama dilinin hepsi temsil ediliyor mu? "EKSİK DİL" uyarılarına bak.
   c. Coğrafi, kaynak ve ideolojik denge sağlanıyor mu? Eğilim dağılımında tek bir kanat ya da tek bir yayın baskın mı?
   d. Serbestiyet ve Kafa için güçlü, özgün bir yazı önerisi çıkarılabilecek malzeme var mı?
   e. Günün herkesçe bilinen büyük gelişmelerinden akışa hiç düşmemiş olan var mı? Bariz gündem başlıklarını kendin say ve akışla karşılaştır.
   f. "Bugün yapılacaklar" için takvim okundu mu (Cuma: hafta sonu dahil)?
5. Tam okuma (web_fetch): analiz, yorum ya da yazı önerisi için özetin yetmediği yazıları tam oku. Akış satırlarında linklerin çoğu kısa referans olarak gelir (`[1004-6eb3d3cb]` gibi); tam okuyacağın öğelerin referanslarını tek bir `get_links` çağrısında topla ve dönen linkleri aç. Referansları bültene yazma. Google News bağlantıları (news.google.com/rss/articles/…) doğrudan açılmayabilir; bu durumda başlık ve yayın adıyla web_search yapıp asıl bağlantıyı bul.
6. Boşluk doldurma (web_search): yalnızca 4. adımda tespit ettiğin eksikler için, dar ve hedefli sorgularla. Genel "bugünün haberleri" taraması yapma.
7. Bütçe: varsayılan olarak en fazla yaklaşık 10 web_fetch ve 6 web_search. Kalite gerektiriyorsa aşabilirsin, ama her ek çağrı belirli bir eksikliği kapatmalı.
8. Akış araçları hata verir ya da boş dönerse, eski yönteme (web_search tabanlı tarama) geç ve bültenin en sonuna tek satırlık bir not düş.
