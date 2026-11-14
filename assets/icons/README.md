# Trailbook B — pełny zestaw ikon

Wersja 1.1.0: przebudowany HIIT (stoper z sektorem interwału) oraz wszystkie
8 ikon grupy sportów rakietowych. Poprawiono ramy, naciągi, uchwyty i proporcje;
padel ma perforacje, pickleball osobny profil paletki i piłkę z otworami,
a badminton czytelną lotkę. Klucze i sposób integracji pozostają takie same.

123 ikony: po jednej dla każdego klucza z katalogu Twojej strony, w tym `other`.
Źródło listy: lokalne `GET /api/types`, odczyt 14 listopada 2026.
To komplet dla tego katalogu Trailbook, a nie deklaracja objęcia każdego profilu we wszystkich urządzeniach Garmin.
Autorskie ikony, nie oficjalne grafiki Garmin. Możesz je używać i modyfikować w swoim projekcie.

## Zawartość

- `svg/`: 123 samodzielne pliki, np. `run.svg`, `yoga.svg`, `ebike_ride.svg`, `other.svg`.
- `trailbook-sprite.svg`: wszystkie ikony jako symbole `tb-<activity_type>`.
- `trailbook-icons.js`: gotowa funkcja renderująca SVG i wybierająca `other` dla nieznanego klucza.
- `trailbook-icons.css`: rozmiar, akcent i wyrównanie ikony z nazwą.
- `manifest.json`: klucze, polskie i angielskie nazwy, grupy oraz ścieżki.
- `preview.html`: samodzielny podgląd offline, grupy, kolor, jasne/ciemne tło.
- `source/`: edytowalne źródła rysunków i generator pakietu.

Każda ikona ma `viewBox="0 0 24 24"`, przezroczyste tło i `currentColor`.
Polecane rozmiary: 20–24 px w listach oraz 32–48 px w kafelkach.
Znaki odmian (teren, obiekt, napęd elektryczny itd.) są czytelniejsze w większym rozmiarze.
Sylwetki i sprzęt mają wspólną grubość optyczną; pokrewne typy dzielą motyw główny.
Joga ma dwie skrzyżowane nogi z prześwitami, zamiast pełnej bryły z pierwszej propozycji.

## Najprostsze użycie w Twoim `preview.js`

Skopiuj pliki JS i CSS do katalogu zasobów strony. W HTML, przed `preview.js`:

```html
<link rel="stylesheet" href="trailbook-icons.css">
<script src="trailbook-icons.js"></script>
<script src="preview.js"></script>
```

Przy nazwie aktywności w liście:

```js
`<span class="tb-activity-name">
  ${TrailbookIcons.render(a.activity_type)}
  ${esc(a.name || typeLabel(a.activity_type))}
</span>`
```

W kafelku:

```js
`${TrailbookIcons.render(a.activity_type, { size: 40 })}
 <b>${esc(a.name || typeLabel(a.activity_type))}</b>`
```

Domyślny kolor pochodzi z istniejącego na stronie `--accent`:

```css
.tb-activity-icon { color: var(--accent); }
```

Nieznany typ automatycznie pokaże `other`:

```js
TrailbookIcons.render('new_garmin_activity');
TrailbookIcons.resolve(null); // 'other'
```

Przy widocznej nazwie ikona jest dekoracyjna (`aria-hidden="true"`).
Jeśli ma być pokazywana samodzielnie, nadaj jej nazwę dostępną:

```js
TrailbookIcons.render('yoga', { size: 40, label: 'Joga' });
```

## Alternatywa: sprite SVG

Serwuj `trailbook-sprite.svg` z tego samego originu co strona:

```html
<svg width="20" height="20" viewBox="0 0 24 24"
     style="color:var(--accent)" aria-hidden="true">
  <use href="trailbook-sprite.svg#tb-run"></use>
</svg>
```

Sprite sam nie wybiera zastępczej ikony. Z JS można zbudować identyfikator:

```js
const symbol = TrailbookIcons.symbolId(a.activity_type);
```

## Alternatywa: pojedynczy SVG

Wstaw zawartość pliku bezpośrednio do HTML, aby odziedziczyć `color`.
Zewnętrzny `<img src="svg/run.svg">` nie dziedziczy koloru z CSS strony.
Dla zewnętrznego pliku można użyć maski:

```css
.activity-run {
  display:inline-block; width:20px; height:20px;
  color:var(--accent); background-color:currentColor;
  -webkit-mask:url("svg/run.svg") center/contain no-repeat;
  mask:url("svg/run.svg") center/contain no-repeat;
}
```

## Weryfikacja

Pakiet sprawdzono pod względem pokrycia 123 kluczy, poprawności XML,
renderowania, granic rysunków, koloru `currentColor`, działania `other`
i dopasowania podglądu do wąskich ekranów. Nie zmienia on plików działającej strony.

## Edycja źródeł

Możesz edytować pojedyncze SVG bez narzędzi budujących. Przy zmianach całego zestawu
edytuj `source/build.py` (rysunki) lub `source/prototypes.svg` (bazowe sylwetki).
Polecenie `python source/build.py`, uruchomione w katalogu pakietu, odtwarza SVG,
sprite, manifest, helper JS i podgląd. Generator wymaga wyłącznie Pythona 3.9+
i jego biblioteki standardowej. Ponowne uruchomienie nadpisuje wygenerowane pliki.
