# Hitster-träning

En PWA för att öva Hitster på egen hand. Appen spelar slumpade låtar från en av dina Spotify-spellistor, och du placerar dem i en tidslinje efter utgivningsår.

## Så fungerar spelet

- Ett slumpat startkort läggs ut med år, titel och artist synliga.
- Nästa låt spelas från början, med titel och artist dolda. Tryck på platsen i tidslinjen där du tror att låten hör hemma.
- **Rätt** betyder att året ligger mellan grannkorten, där lika år räknas som rätt. Ligger ett kort på 2015 och den nya låten också är från 2015 blir det rätt oavsett om du väljer före eller efter. Låten sparas då i tidslinjen.
- **Fel** betyder att låten kasseras.
- Du vinner när tidslinjen har **10 kort**, startkortet inräknat.
- Varje låt dras bara en gång per spel. Om listan tar slut innan du nått 10 kort avslutas spelet som **ej vunnet**.
- Efter varje spel ser du antal rätt och fel, din träffprocent och din längsta svit. Du ser också statistik över alla spel: snittlängd på sviter, snitt av längsta svit per spel, rekord och träffprocent över tid.
- Låtens år hämtas från **MusicBrainz**, som anger låtens första utgivning och slås upp via låtens ISRC-kod. Om låten inte finns där används **Spotify-albumets år**. Under svaret står det vilken källa som gav året.
- Statistik, årscache och ett pågående spel sparas bara i webbläsaren på din enhet.

## Installation (cirka 15 minuter, görs en gång)

### 1. Lägg upp appen på GitHub Pages

1. Skapa ett **publikt** repo på GitHub, till exempel `hitster-traning`. GitHub Pages är gratis för publika repon.
2. Välj **Add file → Upload files** och dra in **alla filer och mappen `icons`** från den här mappen. Klicka på **Commit changes**.
3. Gå till **Settings → Pages**. Under *Build and deployment* väljer du **Deploy from a branch**, branch **main** och mapp **/ (root)**. Klicka på **Save**.
4. Efter en minut eller två ligger appen på `https://<ditt-användarnamn>.github.io/hitster-traning/`. Spara adressen, inklusive det sista snedstrecket.

### 2. Skapa en Spotify-app (för att få ett Client ID)

Kontot som äger appen måste ha **Spotify Premium**.

1. Gå till <https://developer.spotify.com/dashboard>, logga in och välj **Create app**.
2. Fyll i ett valfritt namn och en valfri beskrivning.
3. Under **Redirect URIs** anger du exakt adressen från steg 1.4, till exempel `https://dittnamn.github.io/hitster-traning/`, och klickar på **Add**.
4. Kryssa i **Web API** och **Web Playback SDK**, godkänn villkoren och spara.
5. Kopiera **Client ID** från appens sida.

En Spotify-app i *Development Mode* får ha högst 5 användare. Om någon annan än du ska använda appen lägger du till deras Spotify-e-post under **User Management**.

### 3. Börja spela

1. Öppna adressen i mobilen, i Safari på iPhone eller Chrome på Android.
2. Klistra in ditt Client ID och logga in med Spotify.
3. Installera appen:
   - **iPhone:** Dela → *Lägg till på hemskärmen*.
   - **Android:** Menyn ⋮ → *Installera app*.
4. Välj en spellista och spela.

## Bra att veta

- **Spellistan måste vara din egen** eller en där du är medarbetare. Spotify lämnar inte ut låtarna i andras listor, och det gäller även Hitsters officiella listor. Om du vill öva på en sådan lista: markera alla låtar i Spotify och lägg till dem i en ny egen spellista.
- **Inget ljud?** På iPhone måste du ibland trycka på **▶ Spela** för att ljudet ska starta. Webbläsare på mobilen kräver ett tryck innan ljud får spelas.
- **Årets precision:** MusicBrainz är en öppen databas som användare fyller i. Den är oftast rätt om originalåret men kan sakna data eller ha fel. Hitsters egna kort kan ibland ange ett annat år än både MusicBrainz och Spotify.
- **Appen hämtar högst ett år per sekund**, eftersom MusicBrainz begränsar anropen. Nästa låts år hämtas medan du gissar, så det märks sällan. Hämtade år sparas på enheten.
- I **Inställningar** kan du byta Client ID, logga ut, nollställa statistiken och tömma årscachen.
- **Demoläge:** Lägg till `?demo` sist i adressen för att testa spelet med påhittade låtar, utan Spotify och utan ljud. Demospel sparas separat från din riktiga statistik.

## Filer

| Fil | Innehåll |
|---|---|
| `index.html` | Sidans struktur |
| `style.css` | Utseende, ljust och mörkt läge |
| `app.js` | All logik: Spotify-inloggning (PKCE), uppspelning, årsuppslag, spel och statistik |
| `sw.js` | Service worker, så att appen kan installeras och startar snabbt |
| `manifest.webmanifest`, `icons/` | PWA-manifest och ikoner |
