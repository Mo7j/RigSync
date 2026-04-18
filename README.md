# RigSync
Senior Project Team-034

## Backend setup

Install Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Import the Excel data into SQLite:

```powershell
python backend/import_dataset.py
```

By default the importer now prefers the latest ISE workbook at `~/Downloads/ise/ise_data_final_v2.xlsx`.
If you need a different workbook, set `RIGSYNC_DATASET_PATH` first:

```powershell
$env:RIGSYNC_DATASET_PATH="C:\path\to\your\workbook.xlsx"
python backend/import_dataset.py
```

Run the API and UI:

```powershell
python backend/app.py
```

Then open `http://127.0.0.1:5000`.
