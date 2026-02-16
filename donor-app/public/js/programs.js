
fetch('/programs')
.then(res => res.json())
.then(data => {
  let rows = '';
  data.forEach(p => {
    rows += `
      <tr>
        <td>${p.program_name}</td>
        <td>${p.description}</td>
      </tr>`;
  });
  document.getElementById('programTable').innerHTML = rows;
});
