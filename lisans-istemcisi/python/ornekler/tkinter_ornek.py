# -*- coding: utf-8 -*-
"""
Tkinter masaüstü programları için örnek (ör. Banka XML Aktarım).

Açılışta lisansı kontrol eder. Etkin değilse ana pencere yerine lisans penceresini açar.
Anahtar girilip etkinleştirilince programa devam edilir. Süresi yaklaşıyorsa uyarı gösterir.
"""
import threading
import tkinter as tk
from tkinter import messagebox, ttk

from odlisans import LicenseClient, LicenseError

PRODUCT = "BNKX"
ACIK_ANAHTAR = "BURAYA_LISANS_ACIK_ANAHTARI"
UYGULAMA_SURUMU = "5.20.14"

lisans = LicenseClient(PRODUCT, ACIK_ANAHTAR, UYGULAMA_SURUMU)


def lisans_penceresi(root: tk.Tk, mesaj: str, devam) -> None:
    win = tk.Toplevel(root)
    win.title("Lisans etkinleştirme")
    win.resizable(False, False)
    win.grab_set()
    frm = ttk.Frame(win, padding=20)
    frm.grid()
    ttk.Label(frm, text="Lisans anahtarınızı girin", font=("Segoe UI", 13, "bold")).grid(sticky="w")
    ttk.Label(frm, text=mesaj, wraplength=420, foreground="#a12a2a").grid(sticky="w", pady=(6, 10))
    anahtar = tk.StringVar()
    ttk.Entry(frm, textvariable=anahtar, width=34, font=("Consolas", 13)).grid(sticky="we")
    durum = ttk.Label(frm, text="")
    durum.grid(sticky="w", pady=6)

    def etkinlestir():
        btn.state(["disabled"])
        durum.config(text="ozkandemir.net'e bağlanılıyor…")

        def is_():
            try:
                st = lisans.activate(anahtar.get())
                root.after(0, lambda: (win.destroy(), messagebox.showinfo("Lisans etkin", f"{st.customer}\nGeçerlilik: {st.expires}"), devam()))
            except LicenseError as e:
                root.after(0, lambda: (durum.config(text=e.message, foreground="#a12a2a"), btn.state(["!disabled"])))
        threading.Thread(target=is_, daemon=True).start()

    btn = ttk.Button(frm, text="İnternet ile etkinleştir", command=etkinlestir)
    btn.grid(sticky="we", pady=(4, 0))

    def cevrimdisi():
        try:
            kod = lisans.offline_request_code(anahtar.get())
        except Exception as e:  # anahtar boş vb.
            messagebox.showerror("Hata", str(e)); return
        root.clipboard_clear(); root.clipboard_append(kod)
        messagebox.showinfo("İstek kodu panoya kopyalandı", "Kodu Özkan Demir'e gönderin. Size verilecek lisans kodunu 'Lisans kodunu kur' ile girin.")

    def kod_kur():
        k = tk.simpledialog.askstring("Lisans kodu", "Özkan Demir'in verdiği lisans kodunu yapıştırın:", parent=win)
        if not k:
            return
        try:
            lisans.install_offline_token(k)
            win.destroy(); devam()
        except LicenseError as e:
            messagebox.showerror("Lisans kodu", e.message)

    alt = ttk.Frame(frm); alt.grid(sticky="we", pady=(10, 0))
    ttk.Button(alt, text="Çevrimdışı istek kodu", command=cevrimdisi).pack(side="left")
    ttk.Button(alt, text="Lisans kodunu kur", command=kod_kur).pack(side="left", padx=6)
    win.protocol("WM_DELETE_WINDOW", root.destroy)


def baslat(ana_pencereyi_kur) -> None:
    import tkinter.simpledialog  # noqa: F401  (kod_kur için)
    root = tk.Tk()
    root.withdraw()

    def devam():
        st = lisans.state(online=False)
        if st.warning:
            messagebox.showwarning("Lisans", st.warning)
        root.deiconify()
        ana_pencereyi_kur(root)

    st = lisans.state()  # gerekiyorsa çevrimiçi doğrular
    if st.ok:
        devam()
    else:
        lisans_penceresi(root, st.message, devam)
    root.mainloop()


if __name__ == "__main__":
    baslat(lambda root: (root.title("Banka XML Aktarım"), ttk.Label(root, text="Program açıldı", padding=40).pack()))
