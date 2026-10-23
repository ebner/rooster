# Nyheter

Vad som har ändrats för dig i varje version av rooster, med den senaste först. Efter en uppdatering visar rooster den här sidan en gång. Du kan öppna den när du vill från Inställningar eller guidens sidlista. Anteckningarna för den som driftar rooster (uppgraderingar, inställningar, säkerhet) finns i [ändringsloggen](../../../CHANGELOG.md) (på engelska).

## 1.8.1

_2026-10-23_

- **Datumarket flimrar inte längre på Android.** Ett tryck på kalendern i en ny uppgifts rad öppnar datumarket en gång, och du kan fortsätta skriva uppgiftens namn efteråt.
- **Inga fler tomma rader.** Med detaljpanelen öppen kunde en ny uppgift lämna en tom rad i listan som inte gick att ta bort förrän du laddade om sidan. Det är åtgärdat.

## 1.8.0

_2026-10-22_

- **Logga in på datorer utan webbläsare.** `rooster login` och AI-agenter som ställs in med `rooster mcp setup --remote` visar en kod; skriv in den på roosters sida **Anslut en enhet** på valfri enhet. Sidan visar vem som frågar och varifrån, och inkorgen berättar när en enhet har anslutits.
- **MCP-token för AI-agenter.** Skapa en token som fungerar med MCP under Inställningar → Säkerhet → Anslutna appar → Ny token, och klistra in raden som rooster visar i Claude Code eller Codex.
- **Nya uppgifter öppnas i detaljpanelen.** När panelen är öppen visas en uppgift du lägger till där så fort du trycker på Enter, så att du direkt kan skriva beskrivningen.
- **Ta bort ett förfallodatum med ett klick.** Ett **×** bredvid förfallodatumet i detaljpanelen tar bort det.

## 1.7.2

_2026-10-19_

- **"Synkar…" försvinner nu på riktigt.** Om en annan rooster-flik på samma telefon eller dator slutar skicka dina ändringar tar appen du har framför dig över efter en kort stund.
- **Uppdateringar fastnar inte.** Om dina ändringar inte kan skickas installerar Ladda om ändå uppdateringen efter några sekunder. Ändringarna ligger kvar på enheten och skickas av den nya versionen.

## 1.7.1

_2026-10-19_

- **Inget mer ändlöst "Synkar…".** På vissa telefoner kunde ändringar fastna på "Synkar…" utan att någonsin sparas, och försvann när appen stängdes. Nu skickas de även när webbläsarens lagring slutar svara.

## 1.7.0

_2026-10-16_

- **Byt organisation med ett svep.** På en telefon sveper du organisationens namn uppe till vänster för att gå till nästa eller föregående organisation, eller håller på det och drar fingret till den du vill ha. Du stannar i samma vy.
- **Öppna länkar i telefonen.** Tryck på en länk i en uppgifts beskrivning för att se vart den leder, och tryck sedan på adressen för att öppna den. Där kan du också redigera eller ta bort länken.

## 1.6.2

_2026-10-13_

- **Imorgon är blått.** En uppgift som förfaller imorgon har ett blått datum i stället för ett orange, så att bara försenade uppgifter ser röda ut.
- **En något mindre layout på stora skärmar.** På skärmar som är minst 1600 pixlar breda är allt nu lika stort som på skärmar från 1440 pixlar, ett steg mindre än förut. Om du har zoomat ut webbläsaren för att göra rooster mindre kan du ställa tillbaka den till 100 %.

## 1.6.1

_2026-10-12_

- **Att välja datum i listan stannar i listan.** När du väljer en dag i en uppgifts datumväljare sätts datumet utan att uppgiftens detaljer öppnas.
- **En större logga i mejlen.**

## 1.6.0

_2026-10-12_

- **Sök i guiden.** Skriv i fältet ovanför guidens sidlista för att hitta alla avsnitt om något, med orden markerade. Accenter spelar ingen roll, och det fungerar också offline. Kommandopaletten (Ctrl+K, eller **Sök** på en telefon) visar de bästa träffarna i guiden under **Hjälp**, efter dina uppgifter.
- **Guidens rubrik är Hjälp**, och sidlistan bredvid visar vilken sida du är på.
- **Terminalappen (TUI) är lättare att hitta i guiden.** Dess sida visar en bild av den och listar alla tangenter.
- **Taggarna krockar inte längre med ikonerna på en rad.** När en rad är för smal för alla taggar, till exempel när detaljerna är öppna bredvid listan, utelämnas de taggar som inte får plats i stället för att hamna över ikonerna bredvid. Detaljerna visar alltid alla taggar.
- **Mejlen visar roosters logotyp** i sidhuvudet, samma som i appen.
- **Administratörer kan skicka ett testmejl** från Administration → System för att kontrollera att roosters mejl fungerar.
- **En lättare flikikon.** roosters ikon i webbläsarfliken har en tunnare linje, närmare logotypen i appen.

## 1.5.3

_2026-10-12_

- **Nyheter:** den här sidan. Efter en uppdatering visar rooster den en gång i ett meddelande längst ned på skärmen, och Inställningar länkar till den när du vill.
- **På en telefon visar raden för en ny uppgift sin kalender.** Tryck på den för att ge uppgiften ett datum medan du skriver namnet, precis som med knappen **Datum** ovanför tangentbordet. Datumet syns direkt på raden, och det fungerar också för en ny deluppgift.
- **Skärmbilderna i guiden visas i sin verkliga storlek.** Telefonbilder blåses inte längre upp till hela bredden, och på breda skärmar står två telefonbilder bredvid varandra.

## 1.5.2

_2026-10-11_

- **Ge en ny uppgift ett datum medan du skriver namnet:** klicka på kalendern till höger på raden, eller tryck på **Tab+D**. Namnet förblir öppet, och Enter skapar uppgiften med det datumet.
- **Sidor öppnas högst upp.** Avsnitt i Inställningar, Admin och guidens sidor börjar inte längre där den förra sidan var bläddrad. Bakåt och Framåt tar dig fortfarande tillbaka dit du var.
- **Menyn i Inställningar ligger kvar** medan ett avsnitt bläddras, och hoppar inte längre i sidled mellan avsnitten.
- **På telefoner och surfplattor** visar rader utan datum en svag kalender där datumet hamnar, och taggar visar sin ta bort-knapp, eftersom det inte finns någon hovring som visar dem.
- **Dra ned för att uppdatera** på en telefon visar sin snurra i minst en halv sekund, så att du ser att den körde.

## 1.5.1

_2026-10-11_

- Android-appens ikon visar tuppen större och centrerad, och logotypen är lite större i sidofältet och på telefoner.

## 1.5.0

_2026-10-10_

- **Den här guiden**, på svenska och engelska, under Hjälp (G och sedan H). Den fungerar också offline.
- **Listans ⋯-meny:** lägg till en grupp, visa klara uppgifter, fäll ihop eller ut alla grupper, exportera och skriv ut bara listan (Ctrl/⌘+P).
- **Inställningar → Beteende:** stäng av att datum känns igen i uppgiftsnamn, och välj hur länge klara uppgifter ligger kvar i listan.
- **Inställningar → Data** visar hur mycket lagring dina bilagor använder.
- **Borttagna inloggningar förblir borttagna:** ett inloggningssätt som du kopplar bort under Inställningar → Säkerhet kan inte logga in dig igen förrän du tillåter det där.
- **Appar och token ser inte längre dina kollegors e-postadresser.** Att tilldela med namn fungerar fortfarande.
- **Snabbare med långa listor:** listan är fortfarande snabb med 2 000 uppgifter.
- **Tillgänglighet:** skärmläsare får fullständiga namn på rader och grupper, och fokus och tryckytor är lättare att se och träffa.
