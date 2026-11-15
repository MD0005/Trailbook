# Aktualizacja finalna

Wersja 1.1.0: 12 ostatnio przeprojektowanych ikon, w tym suma podejść i zejść w wariancie A (profil terenu). Poprawki są obecne w SVG, sprite, helperze JS i podglądzie.

# Trailbook — ikony parametrów

86 ikon nazwanych parametrów oraz ikona zastępcza `other`. Zakres: pierwsza tabela
„Katalog przydatny przy projektowaniu Trailbook” — od czasu, dystansu, HR i mocy
po ocenę treningu i urządzenia. Nazwane warianty średnia/minimum/maksimum mają osobne pliki.
Nie jest to zestaw ikon drugiej tabeli metryk specyficznych dla sportów ani wszystkich pól FIT.
Ogólne pozycje tabeli rozwinięto m.in. na szerokość/długość GPS oraz rodzaje kalorii.

## Dwa rozmiary

- `20/`: 87 SVG z `width="20" height="20"` — małe ikony do list.
- `32/`: 87 SVG z `width="32" height="32"` — dokładnie 1,6× większe.
- `master/`: te same rysunki bez narzuconego rozmiaru.
- Wspólny `viewBox="0 0 24 24"`, przezroczyste tło, wyłącznie `currentColor`.

Wersja 32 px jest proporcjonalnym skalowaniem tej samej geometrii, z kreską rosnącą
razem z ikoną. Rysunki sprawdzono w obu rozmiarach. Nie zawierają bitmap, fontów,
tekstów SVG, masek zależnych od koloru tła ani odwołań do zewnętrznych zasobów.

## Oznaczenia wariantów

- Średnia: dwie poziome kreski w osobnym miejscu obok motywu podstawowego.
- Minimum: strzałka w dół.
- Maksimum: strzałka w górę.
- Najlepsze tempo: strzałka w dół — mniejsza liczba min/km oznacza szybsze tempo.

Ikony towarzyszą etykietom i wartościom. Same techniczne znaki HRV, RMSSD, SDRR,
TSS czy IF nie zastępują czytelnej nazwy parametru.

## Użycie na stronie

```html
<link rel="stylesheet" href="metric-icons.css">
<script src="metric-icons.js"></script>
```

```js
TrailbookMetricIcons.render('heart_rate');             // 20 px
TrailbookMetricIcons.render('power', { size: 32 });     // 32 px
TrailbookMetricIcons.render('avg_heart_rate');
TrailbookMetricIcons.render('nowy_parametr');           // other
```

Przykład wiersza:

```js
`<span class="tb-metric-label">
  ${TrailbookMetricIcons.render('heart_rate')}
  Tętno: ${esc(value)} bpm
</span>`
```

CSS korzysta z istniejącego akcentu `--accent`. Jeżeli używasz innej zmiennej:

```css
.tb-metric-icon { color:var(--kolor-akcentu); }
```

Domyślnie ikony mają `aria-hidden="true"`. Dla samodzielnej ikony użyj:

```js
TrailbookMetricIcons.render('power', {size:32, label:'Moc'});
```

## Sprite lub pojedynczy plik

```html
<svg width="32" height="32" viewBox="0 0 24 24"
     style="color:var(--accent)" aria-hidden="true">
  <use href="metric-sprite.svg#tbm-heart_rate"></use>
</svg>
```

Serwuj sprite z tego samego originu co stronę. Do pojedynczego SVG możesz wkleić
jego zawartość bezpośrednio w HTML. Samo `<img src="20/heart_rate.svg">` nie dziedziczy
koloru CSS z rodzica; dla zewnętrznego pliku użyj `mask-image` z
`background-color:currentColor` albo zastosuj powyższy helper/sprite.

## Pliki pomocnicze

- `preview.html`: samodzielny podgląd offline; każda ikona obok siebie w 20 i 32 px.
- `manifest.json`: grupy, polskie etykiety, nazwy ikon, warianty i ścieżki.
- `COVERAGE.md`: pełna lista pokrycia parametrów pierwszej tabeli.
- `source/build.py`: edytowalne rysunki i generator, Python 3.9+ bez bibliotek zewnętrznych.

Uruchomienie `python source/build.py` w katalogu paczki odtwarza SVG, sprite,
manifest, helper i podgląd. Nadpisuje wygenerowane pliki.

Klucze są nazwami ikon interfejsu, nie automatycznym mapowaniem pól FIT.
Np. `heart_rate` może reprezentować pole z FIT, a `pace` wartość obliczoną z prędkości.
Autorskie ikony możesz używać i modyfikować w swoim projekcie.
