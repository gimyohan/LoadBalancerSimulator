# 현실 데이터셋 보고서

작성일: 2026-10-24

## 요약

합성 시나리오만으로는 실제 트래픽의 도착 패턴, 세션 수명, 크기 분포를 재현하기 어려워, 공개된 운영 트레이스 두 개를
이벤트 데이터셋(`PROJECT_SPEC.md` 3장)으로 옮겼다.

| 데이터셋 | 출처 | 규모 | 우리 데이터로 | 특징 |
| --- | --- | --- | --- | --- |
| Azure VM 트레이스 2019 | Microsoft Azure Public Dataset V2 | VM 2,695,548대, 30일 | 세 가지 판: 전체 30일 → 세션 2,695,548개, 시작·종료가 모두 관측된 VM만 → 2,422,964개, 둘째 주 10% 표본 → 82,462개 | 수명이 몇 분에서 며칠까지 퍼져 있고 크기(코어 수)가 다양한 세션 |
| Azure Functions 호출 트레이스 2021 | Microsoft Azure Public Dataset | 호출 1,980,951건, 2주 | 2주 전체, 10% 표본 → 세션 197,978개 | 아주 짧고 몰려 오는 서버리스 요청, 크기 정보 없음 |

- 변환은 세 프로그램(생성기·엔진·대시보드)과 독립된 로컬 스크립트 `tools/migrate/`가 맡는다. 출처마다 형식이 달라
  읽는 쪽은 출처별 스크립트로 두고, 명세의 이벤트 CSV를 쓰는 출력 쪽만 공통 모듈로 둔다.
- 원본(`data/raw/`), 변환 결과(`data/`), 변환 스크립트(`tools/migrate/`)는 모두 `.gitignore` 대상이다.
- 이 밖에 NASA-HTTP 웹 로그, 상하이 텔레콤 기지국 접속 기록, Telecom Italia 밀라노 통신량, WikiBench 위키백과 요청 로그를
  검토했고, 3절에 요약했다.

## 1. 추가한 데이터셋

### 1.1 Azure VM 트레이스 2019

Microsoft가 공개한 Azure 한 지역의 실제 VM 작업량에서 민감 정보를 지운 일부다. VM 하나의 생성부터 삭제까지가 세션 하나에 대응한다.

| 항목 | 내용 |
| --- | --- |
| 출처 | [Azure Public Dataset V2](https://github.com/Azure/AzurePublicDataset/blob/master/AzurePublicDatasetV2.md) |
| 라이선스 | CC-BY-4.0. 결과를 발표할 때는 [Resource Central (SOSP'17)](https://www.microsoft.com/en-us/research/publication/resource-central-understanding-predicting-workloads-improved-resource-management-large-cloud-platforms/)을 인용한다 |
| 파일 | [`trace_data_vmtable_vmtable.csv.gz`](https://github.com/Azure/AzurePublicDataset/releases/download/dataset-v2/trace_data_vmtable_vmtable.csv.gz) 437.6MB (풀면 821.2MB) → `data/raw/vmtable_2019.csv.gz` |
| 형식 | 머리글 없는 11열 CSV: `vmid, subscriptionid, deploymentid, vmcreated, vmdeleted, maxcpu, avgcpu, p95maxcpu, vmcategory, vmcorecountbucket, vmmemorybucket` |
| 시각 | 초 단위, 0부터 2,591,400초(30일)까지. 모두 5분(300초) 단위로 기록돼 있다 |

원본에서 직접 센 특성:

| 특성 | 값 |
| --- | --- |
| 수명 | 18%가 5분, 64%가 1시간, 87%가 하루 안에 끝난다. 생성과 삭제가 같은 5분 칸에 기록된 VM이 144,461대 |
| 관측 경계 | 시작이 잘린 VM(생성 시각 0) 227,316대(8.43%), 종료가 잘린 VM(삭제 시각 = 트레이스 끝) 224,509대(8.33%), 둘 다 179,241대, 둘 중 하나 이상 272,584대(10.11%). 이 10%가 전체 부하(코어 × 시간)의 90.1%를 차지한다 |
| 코어 수 | 2코어 1,586,588대(59%), 4코어 823,893대, 8코어 193,643대, 24코어 80,501대, '>24' 10,923대 |
| 메모리 | 2·4·8·32·64·'>64' GB 구간. 8GB가 1,014,932대로 가장 많다 |
| 일별 생성 수 | 첫날(관측 전 VM 포함 317,222대)을 빼면 하루 5.3만~9.8만 대. 7일 간격으로 낮은 날이 반복된다 |

원 논문은 같은 작업량에 대해 VM의 약 80%가 1~2코어이고, 도착은 몰려 오며 하루 주기가 있고 주말에 낮다고 보고했다.

### 1.2 Azure Functions 호출 트레이스 2021

Azure Functions(서버리스)의 실제 호출 기록이다. 호출 하나의 시작부터 끝까지가 세션 하나에 대응한다.

| 항목 | 내용 |
| --- | --- |
| 출처 | [Azure Functions Invocation Trace 2021](https://github.com/Azure/AzurePublicDataset/blob/master/AzureFunctionsInvocationTrace2021.md) |
| 라이선스 | CC-BY-4.0 ([Azure Public Dataset](https://github.com/Azure/AzurePublicDataset)) |
| 파일 | [`AzureFunctionsInvocationTraceForTwoWeeksJan2021.rar`](https://github.com/Azure/AzurePublicDataset/raw/master/data/AzureFunctionsInvocationTraceForTwoWeeksJan2021.rar) 18.4MB (풀면 305.4MB의 `.txt`) |
| 형식 | 머리글 있는 CSV: `app, func, end_timestamp, duration` (초) |
| 기간 | 2021-01-31부터 2주. 원 트레이스에서 시각이 일부 바뀌어 공개됐다 |

원본에서 직접 센 특성:

| 특성 | 값 |
| --- | --- |
| 규모 | 호출 1,980,951건, 앱 119개 |
| 실행 시간 | 62%가 0.1초, 87%가 1초, 94%가 10초, 98.6%가 60초 안에 끝난다. 가장 긴 호출은 578.6초 |
| 일별 호출 수 | 4.7만~29.0만 건. 첫 주는 3~4일째가 가장 많다 |
| 동시 호출 (10% 표본) | 평균은 1개 미만인데 짧은 몰림에서 310개까지 올라간다 |
| 자원 크기 | 기록이 없다. 가중치는 모두 1이다 |

## 2. 데이터 마이그레이션 방법

### 2.1 원칙과 구조

- **세 프로그램과 독립:** 생성기·엔진·대시보드는 외부 데이터를 모른다. 변환 결과가 명세의 이벤트 CSV이므로 엔진과 대시보드는
  생성기가 만든 데이터셋과 똑같이 읽는다.
- **출처별 읽기, 공통 출력:** 출처마다 형식과 판단(관측 경계를 알아보는 방법 등)이 달라 일반화하지 않는다.
  공통 모듈은 출력 쪽만 맡는다.
- **로컬 전용:** 스크립트와 데이터는 `.gitignore` 대상이다. 다른 PC에서는 아래 링크와 명령으로 다시 만든다.

```
data/raw/<원본> ─▶ tools/migrate/<출처>.py ─▶ lb_events.py ─▶ data/<이름>.csv ─▶ lb_simulator, 대시보드
                   (읽기·출처별 판단)          (구간·표본·jitter,
                                               ID·시각 고유화·검증·쓰기)
```

| 파일 | 역할 |
| --- | --- |
| `tools/migrate/azure_vm.py` | vmtable(`.csv` 또는 `.csv.gz`) 읽기, 코어·메모리 구간 → 가중치, 관측 전 VM 판정 |
| `tools/migrate/azure_functions.py` | 호출 트레이스 읽기, `end_timestamp − duration` → 시작 |
| `tools/migrate/lb_events.py` | 구간 자르기·표본·jitter, 세션 ID와 ms 시각 부여, 제약 조건 검사, CSV 쓰기 |
| `tools/migrate/README.md` | 다운로드 링크, 옵션, 데이터 특성 |

Python 3.10 이상의 표준 라이브러리만 쓴다. 내려받은 데이터를 읽으므로 `python -I`(격리 모드)로 실행한다.

### 2.2 변환 규칙

| 단계 | 규칙 | 이유 |
| --- | --- | --- |
| 세션 대응 | VM: 생성 → 연결, 삭제 → 해제. Functions: 끝 − 실행 시간 → 연결, 끝 → 해제 | 명세의 연결/해제 한 쌍 |
| 가중치 | VM: 코어 수 구간(`--weight memory`면 메모리 GB). '>24'는 30, '>64'는 70. Functions: 1 | '>' 구간 값은 [Azure 분석 노트북](https://github.com/Azure/AzurePublicDataset/tree/master/analysis)과 같다 |
| 구간 | `--start`부터 `--length`까지 연결된 세션만 쓰고 `--start`를 0으로 옮긴다. 해제는 구간 뒤여도 실제 시각대로 둔다 | 긴 트레이스에서 원하는 기간만 쓴다 |
| 관측 전 세션 | 구간 시작 전부터 살아 있던 세션은 `keep`(기본)이면 구간 시작에 연결, `drop`이면 뺀다. VM 트레이스에서 생성 시각이 가장 이른 시각(0)인 VM도 관측 전 VM으로 본다 | `keep`은 구간 시작의 실제 부하 상태를 재현한다 |
| 관측 끝 세션 (VM) | 삭제 시각이 트레이스 끝(가장 늦은 삭제 시각, 2,591,400초)인 VM은 끝까지 살아 있던 VM으로 본다. `--unfinished keep`(기본)이면 그 시각에 해제, `drop`이면 뺀다 | 22.5만 대가 정확히 이 값에 몰려 있다. Azure 문서에 명시된 규칙은 아니고 분포로 판단했다 |
| 표본 | `--sample` 비율만 남긴다. `--seed`로 재현된다 | 원본이 커서 다루기 좋은 크기로 줄인다 |
| 시각 퍼뜨리기 | VM은 각 시각을 그 5분 칸 안 `[t, t+300)`에 균등하게 퍼뜨린다(`--jitter`). 같은 칸 안에서 생기고 끝난 VM은 그 칸 안의 두 시각이 된다 | 그대로 쓰면 수천 개 이벤트가 한 순간에 몰린다 |
| 시각 고유화 | 시각을 ms로 반올림하고, 앞 이벤트와 같거나 이르면 1ms씩 민다. 1ms보다 짧은 세션은 1ms로 둔다 | 명세 3.2: 모든 시각은 서로 다르고 해제는 연결보다 뒤 |
| 검증 | 쓰기 전에 제약 조건을 검사하고 어기면 쓰지 않는다. 엔진도 읽을 때 다시 검사한다 | |

### 2.3 실행과 결과

```bash
python -I tools/migrate/azure_vm.py data/raw/vmtable_2019.csv.gz -o data/azure_vm_full.csv
python -I tools/migrate/azure_vm.py data/raw/vmtable_2019.csv.gz -o data/azure_vm_complete.csv \
    --existing drop --unfinished drop
python -I tools/migrate/azure_vm.py data/raw/vmtable_2019.csv.gz -o data/azure_vm_week2.csv \
    --start 604800 --length 604800 --sample 0.1
python -I tools/migrate/azure_functions.py data/raw/AzureFunctionsInvocationTraceForTwoWeeksJan2021.txt \
    -o data/azure_functions_10pct.csv --sample 0.1
```

| 결과 | Azure VM 전체 (`azure_vm_full.csv`) | Azure VM 관측 완료분 (`azure_vm_complete.csv`) | Azure VM 둘째 주 10% (`azure_vm_week2.csv`) | Azure Functions 10% (`azure_functions_10pct.csv`) |
| --- | --- | --- | --- | --- |
| 구간 / 표본 | 30일 전체 / 없음 | 30일 전체 / 없음, 시작·종료가 잘린 VM 제외 | 7~14일째 / 10% | 2주 전체 / 10% |
| 읽은 세션 | 2,695,548 | 2,695,548 | 2,695,548 | 1,980,951 |
| 구간 밖 제외 | 0 | 272,584 (종료가 잘린 224,509 + 시작만 잘린 48,075) | 1,869,263 | 0 |
| 표본에서 제외 | 0 | 0 | 743,823 | 1,782,973 |
| 사용한 세션 | 2,695,548 (관측 전 VM 227,316 포함) | 2,422,964 | 82,462 (구간 시작 전부터 있던 VM 포함) | 197,978 |
| 이벤트 | 5,391,096 | 4,845,928 | 164,924 | 395,956 |
| 최대 동시 세션 / 최대 총 가중치 | 232,281 / 685,724코어 | 28,520 / 111,440코어 | 22,873 / 66,112코어 | 310 / 310 |
| 변환 시간 | 약 1분 10초 | 약 33초 | 약 20초 | 약 8초 |
| 파일 크기 | 159MB | 144MB | 4.4MB | 11.1MB |

전체판은 원본의 규모와 몰림을 그대로 담는다. 관측 완료분은 시작·종료가 모두 기록된 VM만 남겨 실제 수명을 아는 세션만 쓴다. 둘째 주 10%판은 첫 주의 관측 시작 왜곡을 피하고 크기를 줄인 판이다.

### 2.4 한계와 주의

- **Functions 압축:** RAR5라 Git Bash의 `bsdtar`와 Windows `tar`로는 풀리지 않는다. 7-Zip 등으로 풀어야 한다.
- **시각 정밀도:** VM 시각은 원래 5분 단위다. jitter로 퍼뜨린 시각은 실제 시각이 아니라 그 5분 안의 그럴듯한 값이다.
- **관측 경계:** 관측 전부터 있던 VM의 실제 생성 시각과, 끝까지 살아 있던 VM의 실제 삭제 시각은 알 수 없다.
  `keep`이면 구간 시작에 수만 개가 한꺼번에 연결되므로, 도착 패턴을 볼 때는 `--existing drop`으로 변환한다.
- **관측 완료분의 편향:** 잘린 VM을 빼면 양 끝에 부하가 빈다. 처음에는 클러스터가 비어 있어 0~2일째 최대 부하가 4.1만~4.8만 코어이고, 끝까지 살아 있을 VM이 빠져 28~29일째는 6.0만→3.4만 코어로 떨어진다. 3~27일째는 6.4만~11.1만 코어다. 오래 사는 VM일수록 경계에 걸려 빠지므로 하루 안에 끝나는 VM이 87%에서 95.8%로 늘어 수명이 짧은 쪽으로 치우친다.
- **표본:** 10% 표본은 동시 세션 수와 총 가중치도 약 10분의 1로 줄인다. VM마다 따로 뽑으므로 한꺼번에 만들어지는
  배포(deployment)의 몰림도 약해진다. 실제 도착 패턴이 중요하면 전체판을 쓴다.
- **크기:** 전체판은 이벤트 539만 개라 대시보드 이벤트 페이지를 처음 여는 데 약 10초가 걸린다.
- **재현성:** 같은 원본·옵션·시드는 같은 파일을 만든다. 다만 Python 난수를 쓰므로 C++ 생성기의 시드와는 무관하다.

## 3. 검토했지만 추가하지 않은 데이터셋

| 데이터셋 | 내용 | 우리 형식과의 대응 | 추가하지 않은 이유와 옮기는 방법 |
| --- | --- | --- | --- |
| [NASA-HTTP 1995](https://ita.ee.lbl.gov/html/contrib/NASA-HTTP.html) | NASA 케네디 우주센터 웹 서버 요청 로그 3,461,612건 (1995년 7~8월). 접속 호스트, 시각, 요청, 응답 코드, 바이트 | 요청 단위라 세션이 없다 | 같은 호스트의 요청을 30분 이상 비면 끊는 식으로 세션을 만들어야 한다. 월별 약 21MB(gzip), FTP. 자유롭게 재배포할 수 있지만 일반적인 트래픽 분석 외의 활용은 자제해 달라는 요청이 있다 |
| [상하이 텔레콤](https://ieee-dataport.org/documents/eua-dataset) | 상하이 기지국 3,233개에서 휴대폰 9,481대의 인터넷 접속 기록 720만 건, 6개월. 사용자, 시작·종료 시각, 기지국 위치 | 기록 하나가 세션 하나. **명세의 기지국 시나리오에 가장 잘 맞는다** | IEEE DataPort 계정이 필요해 직접 받아야 한다. 받으면 시작·종료를 그대로 쓰고 가중치는 1 |
| [Telecom Italia 밀라노](https://theodi.fbk.eu/openbigdata) | 밀라노를 100×100 칸으로 나눠 10분마다 집계한 SMS·통화·인터넷 통신량 (2013년 11~12월, 출처에 따라 기간 표기가 다름). ODbL | 집계값이라 세션 기록이 없다 | 시간에 따른 도착률 곡선으로만 쓸 수 있다. 옮기려면 그 곡선을 따라 세션을 뽑는 변환 스크립트가 필요하고, 지속 시간과 크기는 가정해야 한다 |
| [WikiBench 위키백과 요청 로그](https://people.cs.umass.edu/~arun/691/datasets/wikipedia.html) | 위키백과 요청 로그 (2009~2010). 요청 ID, 시각, URL. 접속자 정보 없음 | 요청 단위이고 세션을 묶을 단서가 없다 | 한 달에 압축 약 250GB로 크고, 받으려면 해당 학과 클러스터 계정이 필요하다. 쓰더라도 요청을 아주 짧은 세션으로 다뤄야 한다 |

## 출처

- [Azure Public Dataset](https://github.com/Azure/AzurePublicDataset), [V2 VM 트레이스 설명](https://github.com/Azure/AzurePublicDataset/blob/master/AzurePublicDatasetV2.md), [Functions 2021 설명](https://github.com/Azure/AzurePublicDataset/blob/master/AzureFunctionsInvocationTrace2021.md)
- [Resource Central: Understanding and Predicting Workloads for Improved Resource Management in Large Cloud Platforms (SOSP'17)](https://www.microsoft.com/en-us/research/publication/resource-central-understanding-predicting-workloads-improved-resource-management-large-cloud-platforms/)
- [NASA-HTTP (Internet Traffic Archive)](https://ita.ee.lbl.gov/html/contrib/NASA-HTTP.html)
- [EUA / 상하이 텔레콤 데이터셋 (IEEE DataPort)](https://ieee-dataport.org/documents/eua-dataset)
- [Telecom Italia Big Data Challenge](https://theodi.fbk.eu/openbigdata)
- [WikiBench 위키백과 트레이스 (UMass CS691)](https://people.cs.umass.edu/~arun/691/datasets/wikipedia.html)
