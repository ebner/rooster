# Inställningar och dina data

Öppna **Inställningar** från menyn under ditt namn längst ner i sidofältet, med `G` och sedan `S`, eller från menyraden längst ner på mobilen. Ändringar sparas direkt.

| Avsnitt | Innehåll |
|---|---|
| **Profil** | Namn, profilbild, språk, tidszon, datum- och tidsformat, installera appen |
| **Beteende** | Datum i uppgiftsnamn, hur länge klara uppgifter syns, svepgester på mobilen |
| **Aviseringar** | Vad som når dig var, push på den här enheten, tider för påminnelser och sammanfattning |
| **Kalenderflöde** | Dina förfallodatum i en kalenderapp |
| **Säkerhet** | Inloggade enheter, länkade identiteter, anslutna appar och token |
| **Data** | Export och papperskorgen |

## Profil

- **Namn:** så som andra ser dig i delade organisationer.
- **Profilbild:** **Ladda upp bild** (PNG, JPEG, GIF, WebP eller AVIF, högst 2 MB), **Byt bild**, eller **Ta bort bild** för att gå tillbaka till bilden från din inloggningstjänst.
- **Språk:** English eller Svenska. Språket avgör också vilka ord rooster förstår när du [skriver datum i rubriker](./dates-and-repeats.md).
- **Tidszon:** vad ”idag” och klockslag betyder för dig. rooster föreslår webbläsarens tidszon.
- **Veckan börjar på:** måndag eller söndag.
- **Datumformat** (månaden eller dagen först) och **Tidsformat** (24 timmar eller 12 timmar). På svenska visas alltid dagen först.
- **Installera appen:** se [Mobil och offline](./phone-and-offline.md#installera-appen).

## Beteende

- **Känn igen datum i uppgiftsnamn:** när det är på får uppgiften ett förfallodatum om du skriver till exempel ”fre” eller ”imorgon 14:00” i namnet (se [Datum och återkommande uppgifter](./dates-and-repeats.md)). Stäng av det för att spara namnen precis som du skriver dem.
- **Dölj klara uppgifter efter:** hur länge en klar uppgift ligger kvar i listan innan den tonas bort: 1,5 s, 3 s eller **Tills sidan laddas om**, som behåller den tills du lämnar listan eller laddar om sidan.
- **Svepgester:** välj vad som händer när du sveper en uppgift åt höger eller vänster på mobilen: Markera som klar, Välj datum, Flytta till grupp, Ta bort eller Ingenting. En förhandsvisning visar vad svepet tar fram.

## Aviseringar och kalenderflöde

Se [Aviseringar](./notifications.md) och [Kalenderflöden](./calendar-feeds.md).

## Säkerhet

- **Inloggade enheter:** alla webbläsare och appar där du är inloggad, och när de senast var aktiva. **Logga ut** loggar ut enheten vid nästa anrop.
- **Länkade identiteter:** kontona du kan logga in med, till exempel Google och företagets inloggning. **Ta bort länk** för ett konto du inte längre använder; det sista går inte att ta bort.
- **Anslutna appar:** token, kommandoradsinloggningar och AI-agenter som använder rooster åt dig, med vad de får göra och när de senast användes. **Redigera** begränsar vad en anslutning får göra, **Återkalla** stoppar den direkt, och **Ny token** skapar en personlig åtkomsttoken. Se [Terminalapp, kommandorad och AI-agenter](./cli-tui-mcp.md#vad-en-anslutning-får-göra).

## Data

Välj en **Organisation** överst; båda delarna gäller en organisation i taget.

- **Exportera:** **Exportera JSON** eller **Exportera Markdown** laddar ner dina grupper, uppgifter, deluppgifter och taggar i organisationen.
- **Papperskorg:** borttagna uppgifter ligger kvar här i 30 dagar och tas sedan bort för gott. Papperskorgen delas av alla i organisationen och visar vem som tog bort vad. **Återställ** lägger tillbaka uppgiften där den var; **Ta bort permanent** tar bort den direkt, och det går inte att ångra.

Om din administratör har satt en lagringskvot för bilagor räknas filer på uppgifter i papperskorgen tills de har tagits bort. Se [Bilagor](./attachments.md#gränser).

Export och papperskorgen kräver en anslutning.

## Organisationsinställningar

Öppna dem från menyn **⋯** bredvid en organisation i sidofältet (**Organisationsinställningar**). Ägare hanterar namn, medlemmar och inbjudningar; alla medlemmar kan hantera taggar och lämna organisationen.

- **Allmänt:** organisationens namn, ikon och färg. Din personliga organisation kan inte byta namn, delas eller tas bort.
- **Medlemmar:** ändra någons roll (**Ägare** eller **Medlem**) eller **Ta bort** personen. Personens uppgifter blir utan ansvarig och personens grupper tas bort. Varje organisation har alltid minst en ägare.
- **Inbjudningar:** bjud in via e-post eller skapa en **Inbjudningslänk** som kan användas **En gång** eller **Flera gånger** och som går ut efter ett antal dagar. Öppna inbjudningar listas och kan återkallas. Om servern inte skickar e-post får du en länk att kopiera i båda fallen.
- **Taggar:** byt namn på en tagg, ändra dess färg, slå ihop den med en annan tagg (**Slå ihop med…**) eller ta bort den från alla uppgifter.
- **Farozon:** **Lämna…** organisationen (du behöver en ny inbjudan för att komma tillbaka), eller, som ägare, **Ta bort…** den med alla uppgifter, grupper och taggar, efter att du har skrivit dess namn.

I [Samarbete](./collaboration.md) står vad medlemmar delar.

## Logga ut

Välj **Logga ut** i menyn under ditt namn. rooster tar då bort allt som sparats om dig på enheten: sparade uppgifter, ändringar som inte har skickats än, senaste sökningar och utkast, och push för enheten. Vänta tills synkstatusen i sidhuvudet har försvunnit innan du loggar ut, så att inga ändringar går förlorade. När du loggar ut ur rooster loggas du inte ut från Google eller företagets inloggning.

## Administration

Om du är administratör för din rooster-server finns också **Administration** i menyn under ditt namn: vilka som får logga in (tillåtna adresser), användare (inaktivera eller aktivera dem), säkerhetskopior (ladda ner en, eller **Säkerhetskopiera nu**), serverns pushnycklar och **System**, där **Skicka testmejl** kontrollerar att roosters mejl fungerar. Driftsguiden beskriver hur servern körs.
