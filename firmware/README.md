# Opravy firmwaru Remora-RT1052

`remora-rt1052-fixes.patch` platí pro [scottalford75/Remora-RT1052-cpp](https://github.com/scottalford75/Remora-RT1052-cpp)
(ověřeno proti commitu `8d44d17`, 14. 6. 2025):

```
git clone https://github.com/scottalford75/Remora-RT1052-cpp.git
cd Remora-RT1052-cpp
git apply --ignore-whitespace ../CNCLinux/firmware/remora-rt1052-fixes.patch
```

Firmware se překládá v MCUXpresso IDE. Opravy zatím nejsou ověřené na hardwaru.

| Soubor | Oprava |
|---|---|
| `DMAstepgen.cpp` | DIR piny `P1_x9` (osa C na `P1_19`) se četly jako jiný pin, takže směr šesté osy byl na špatném výstupu. |
| `ethernet.cpp` | UDP paket delší než buffer (64 B data, 57 B NVMPG) přepsal paměť. Kopie je teď omezená a krátké pakety se zahazují. |
| `tftpserver.cpp`, `configuration.h` | Před nahráním konfigurace se mazalo jen 8 kB flash, takže větší konfigurace se tiše poškodila. Teď se maže 16 kB a nic se nezapíše mimo tuto oblast. |
| `remora-rt1052.cpp` | Po neúspěšném nahrání konfigurace zůstaly zastavené thready a deska nereagovala. Teď se restartuje s předchozí konfigurací. Přibyla kontrola délky konfigurace ve flash (zbytky Mach3 firmwaru) a velký buffer už není na zásobníku. |
| `remora-eth-3.0.c` (HAL) | Filtr špiček zpětné vazby měl pevný limit 250 kroků za cyklus, takže nad 250 kHz držel polohu a vznikaly following errory. Limit se teď počítá z `PRU_base_freq`. |

OpenCNC Web generuje konfiguraci desky kompaktně (zhruba 4,7 kB), takže funguje i s neopraveným firmwarem 3.1.3.
